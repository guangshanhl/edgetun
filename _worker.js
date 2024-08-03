import { connect } from 'cloudflare:sockets';

export default {
    async fetch(request, env) {
        try {
            const userID = env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4';
            const proxyIP = env.PROXYIP || '';
            const upgradeHeader = request.headers.get('Upgrade');
            if (upgradeHeader === 'websocket') {
                return handleWebSocket(request, userID, proxyIP);
            }
            return handleNonWebSocketRequest(request, userID);
        } catch (err) {
            return new Response(err.toString());
        }
    },
};

async function handleNonWebSocketRequest(request, userID) {
    const url = new URL(request.url);
    if (url.pathname === '/') {
        return new Response(JSON.stringify(request.cf, null, 4), { status: 200 });
    }
    if (url.pathname === `/${userID}`) {
        return new Response(getVLESSConfig(userID, request.headers.get('Host')), {
            status: 200,
            headers: { "Content-Type": "text/plain;charset=utf-8" }
        });
    }
    url.hostname = 'bing.com';
    url.protocol = 'https:';
    return fetch(new Request(url, request));
}

async function handleWebSocket(request, userID, proxyIP) {
    const [client, webSocket] = new WebSocketPair();
    webSocket.accept();
    const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
    const readableStream = createReadableWebSocketStream(webSocket, earlyDataHeader);
    let remoteSocket = { value: null };
    let udpStreamWrite = null;
    let isDns = false;
    readableStream.pipeTo(new WritableStream({
        async write(chunk) {
            if (isDns && udpStreamWrite) {
                udpStreamWrite(chunk);
                return;
            }
            if (remoteSocket.value) {
                const writer = remoteSocket.value.writable.getWriter();
                await writer.write(chunk);
                writer.releaseLock();
                return;
            }
            const { hasError, addressRemote, portRemote, rawDataIndex, vlessVersion, isUDP } = processVlessHeader(chunk, userID);
            if (hasError) return;
            if (isUDP && portRemote === 53) {
                isDns = true;
            } else if (isUDP) {
                return;
            }
            const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
            const rawClientData = chunk.slice(rawDataIndex);
            if (isDns) {
                const { write } = await handleUDPOutbound(webSocket, vlessResponseHeader);
                udpStreamWrite = write;
                udpStreamWrite(rawClientData);
            } else {
                handleQUICOutbound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, proxyIP);
            }
        },
    }));
    return new Response(null, { status: 101, webSocket: client });
}

async function handleQUICOutbound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, proxyIP) {
    const connectAndWrite = async (address, port) => {
        const quicSocket = connect({ hostname: address, port, protocol: 'quic' });
        remoteSocket.value = quicSocket;
        const writer = quicSocket.writable.getWriter();
        await writer.write(rawClientData);
        writer.releaseLock();
        return quicSocket;
    };
    const retry = async () => {
        const quicSocket = await connectAndWrite(proxyIP || addressRemote, portRemote);
        quicSocket.closed.catch(() => {}).finally(() => closeWebSocketSafely(webSocket));
        forwardDataToWebSocket(quicSocket, webSocket, vlessResponseHeader, null);
    };
    const quicSocket = await connectAndWrite(addressRemote, portRemote);
    forwardDataToWebSocket(quicSocket, webSocket, vlessResponseHeader, retry);
}

function createReadableWebSocketStream(webSocket, earlyDataHeader) {
    let isCancelled = false;
    return new ReadableStream({
        start(controller) {
            const handleMessage = event => {
                if (!isCancelled) {
                    controller.enqueue(event.data);
                }
            };
            webSocket.addEventListener('message', handleMessage);
            webSocket.addEventListener('close', () => controller.close());
            webSocket.addEventListener('error', err => controller.error(err));
            const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
            if (error) {
                controller.error(error);
            } else if (earlyData) {
                controller.enqueue(earlyData);
            }
        },
        cancel() {
            isCancelled = true;
            closeWebSocketSafely(webSocket);
        }
    });
}

function processVlessHeader(vlessBuffer, userID) {
    if (vlessBuffer.byteLength < 24) return { hasError: true };
    const version = vlessBuffer.slice(0, 1);
    const isValidUser = stringify(new Uint8Array(vlessBuffer.slice(1, 17))) === userID;
    if (!isValidUser) return { hasError: true };
    const optLength = new DataView(vlessBuffer.slice(17, 18)).getUint8(0);
    const command = new DataView(vlessBuffer.slice(18 + optLength, 18 + optLength + 1)).getUint8(0);
    if (![1, 2].includes(command)) return { hasError: true };
    const isUDP = command === 2;
    const portIndex = 18 + optLength + 1;
    const portRemote = new DataView(vlessBuffer.slice(portIndex, portIndex + 2)).getUint16(0);
    const addressIndex = portIndex + 2;
    const addressType = new DataView(vlessBuffer.slice(addressIndex, addressIndex + 1)).getUint8(0);
    let addressLength = 0;
    let addressValueIndex = addressIndex + 1;
    let addressValue = '';
    switch (addressType) {
        case 1:
            addressLength = 4;
            addressValue = Array.from(new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength))).join('.');
            break;
        case 2:
            addressLength = new DataView(vlessBuffer.slice(addressValueIndex, addressValueIndex + 1)).getUint8(0);
            addressValueIndex += 1;
            addressValue = new TextDecoder().decode(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
            break;
        case 3:
            addressLength = 16;
            addressValue = Array.from({ length: 8 }, (_, i) => new DataView(vlessBuffer.slice(addressValueIndex + i * 2, addressValueIndex + (i + 1) * 2)).getUint16(0).toString(16)).join(':');
            break;
        default:
            return { hasError: true };
    }
    if (!addressValue) return { hasError: true };
    return {
        hasError: false,
        addressRemote: addressValue,
        portRemote,
        rawDataIndex: addressValueIndex + addressLength,
        vlessVersion: version,
        isUDP
    };
}

async function forwardDataToWebSocket(remoteSocket, webSocket, vlessResponseHeader, retry) {
    let hasIncomingData = false;
    try {
        await remoteSocket.readable.pipeTo(new WritableStream({
            async write(chunk) {
                hasIncomingData = true;
                if (webSocket.readyState !== WebSocket.OPEN) throw new Error('WebSocket is not open');                
                if (vlessResponseHeader) {
                    const combinedData = new Uint8Array([...vlessResponseHeader, ...new Uint8Array(chunk)]);
                    webSocket.send(combinedData.buffer);
                    vlessResponseHeader = null;
                } else {
                    webSocket.send(chunk);
                }
            }
        }));
    } catch {
        closeWebSocketSafely(webSocket);
    }
    if (!hasIncomingData && retry) retry();
}

function base64ToArrayBuffer(base64Str) {
    if (!base64Str) return { error: null };
    try {
        base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
        const binaryString = atob(base64Str);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return { earlyData: bytes.buffer, error: null };
    } catch (error) {
        return { error };
    }
}

function closeWebSocketSafely(socket) {
    try {
        if ([WebSocket.OPEN, WebSocket.CLOSING].includes(socket.readyState)) {
            socket.close();
        }
    } catch {}
}

const byteToHex = Array.from({ length: 256 }, (_, i) => (i + 256).toString(16).slice(1));
function stringify(arr) {
    return Array.from(arr.slice(0, 16), byte => byteToHex[byte]).join('')
        .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')
        .toLowerCase();
}

async function handleUDPOutbound(webSocket, vlessResponseHeader) {
    let isHeaderSent = false;
    const transformStream = new TransformStream({
        transform(chunk, controller) {
            let index = 0;
            while (index < chunk.byteLength) {
                const udpPacketLength = new DataView(chunk.slice(index, index + 2)).getUint16(0);
                controller.enqueue(chunk.slice(index + 2, index + 2 + udpPacketLength));
                index += 2 + udpPacketLength;
            }
        }
    });
    const dnsFetch = async (chunk) => {
        const response = await fetch('https://cloudflare-dns.com/dns-query', {
            method: 'POST',
            headers: { 'content-type': 'application/dns-message' },
            body: chunk
        });
        return response.arrayBuffer();
    };
    transformStream.readable.pipeTo(new WritableStream({
        async write(chunk) {
            const dnsResult = await dnsFetch(chunk);
            const udpSizeBuffer = new Uint8Array([(dnsResult.byteLength >> 8) & 0xff, dnsResult.byteLength & 0xff]);
            if (webSocket.readyState === WebSocket.OPEN) {
                const combinedData = new Uint8Array([...(!isHeaderSent ? vlessResponseHeader : []), ...udpSizeBuffer, ...new Uint8Array(dnsResult)]);
                webSocket.send(combinedData.buffer);
                isHeaderSent = true;
            }
        }
    }));
    const writer = transformStream.writable.getWriter();
    await writer.write(chunk);
}

function getVLESSConfig(userID, hostName) {
    return `
################################################################
---------------------------------------------------------------
vless://${userID}\u0040${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}
---------------------------------------------------------------
################################################################
`;
}
