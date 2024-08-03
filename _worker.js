import { connect } from 'cloudflare:sockets';

export default {
    async fetch(request, env) {
        const userID = env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4';
        const proxyIP = env.PROXYIP || '';
        const upgradeHeader = request.headers.get('Upgrade');        
        if (upgradeHeader === 'websocket') {
            return handleWebSocket(request, userID, proxyIP);
        }
        return handleNonWebSocketRequest(request, userID);
    },
};

async function handleNonWebSocketRequest(request, userID) {
    const url = new URL(request.url);
    const host = request.headers.get('Host');
    const pathname = url.pathname;
    if (pathname === '/') {
        return new Response(JSON.stringify(request.cf, null, 4), { status: 200 });
    }    
    if (pathname === `/${userID}`) {
        return new Response(getVLESSConfig(userID, host), {
            status: 200,
            headers: {
                "Content-Type": "text/plain;charset=utf-8",
                "Alt-Svc": 'h3=":443"; ma=86400'
            }
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
    let udpStreamWrite = null;
    let isDns = false;
    readableStream.pipeTo(new WritableStream({
        async write(chunk) {
            if (udpStreamWrite && isDns) {
                udpStreamWrite(chunk);
                return;
            }
            if (remoteSocket.value) {
                await writeToRemoteSocket(remoteSocket.value, chunk);
                return;
            }
            const { hasError, addressRemote, portRemote, rawDataIndex, vlessVersion, isUDP } = processVlessHeader(chunk, userID);
            if (hasError) return;
            if (isUDP) {
                handleUDPOrQUIC(isDns, portRemote, chunk.slice(rawDataIndex), vlessVersion, webSocket, proxyIP);
            } else {
                handleQUICOutbound(remoteSocket, addressRemote, portRemote, chunk.slice(rawDataIndex), webSocket, new Uint8Array([vlessVersion[0], 0]), proxyIP);
            }
        }
    }));
    return new Response(null, { status: 101, webSocket: client });
}

async function writeToRemoteSocket(remoteSocket, chunk) {
    const writer = remoteSocket.writable.getWriter();
    await writer.write(chunk);
    writer.releaseLock();
}

async function handleUDPOrQUIC(isDns, portRemote, rawClientData, vlessVersion, webSocket, proxyIP) {
    if (portRemote === 53) {
        isDns = true;
        const { write } = await handleUDPOutbound(webSocket, new Uint8Array([vlessVersion[0], 0]));
        udpStreamWrite = write;
        udpStreamWrite(rawClientData);
    }
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
    const quicSocket = await connectAndWrite(addressRemote, portRemote);
    forwardDataToWebSocket(quicSocket, webSocket, vlessResponseHeader, async () => {
        const fallbackSocket = await connectAndWrite(proxyIP || addressRemote, portRemote);
        fallbackSocket.closed.catch(() => {}).finally(() => closeWebSocketSafely(webSocket));
        forwardDataToWebSocket(fallbackSocket, webSocket, vlessResponseHeader, null);
    });
}

function createReadableWebSocketStream(webSocket, earlyDataHeader) {
    let isCancelled = false;
    const handleMessage = event => {
        if (!isCancelled) {
            controller.enqueue(event.data);
        }
    };
    const handleError = err => {
        if (!isCancelled) {
            controller.error(err);
        }
    };
    const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
    return new ReadableStream({
        start(controller) {
            if (error) {
                controller.error(error);
                return;
            }            
            if (earlyData) {
                controller.enqueue(earlyData);
            }
            webSocket.addEventListener('message', handleMessage);
            webSocket.addEventListener('close', () => controller.close());
            webSocket.addEventListener('error', handleError);
        },
        cancel() {
            isCancelled = true;
            closeWebSocketSafely(webSocket);
        }
    });
}

function processVlessHeader(vlessBuffer, userID) {
    if (vlessBuffer.byteLength < 24) return { hasError: true };
    const view = new DataView(vlessBuffer);
    const version = vlessBuffer.slice(0, 1);
    const isValidUser = stringify(new Uint8Array(vlessBuffer.slice(1, 17))) === userID;
    if (!isValidUser) return { hasError: true };
    const optLength = view.getUint8(17);
    const command = view.getUint8(18 + optLength);
    if (![1, 2].includes(command)) return { hasError: true };
    const isUDP = command === 2;
    const portRemote = view.getUint16(18 + optLength + 1);
    const addressType = view.getUint8(21 + optLength);   
    const { addressValue, addressValueIndex, addressLength } = parseAddress(vlessBuffer, addressType, 22 + optLength);
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

function parseAddress(buffer, type, startIndex) {
    const view = new DataView(buffer);
    let addressValue = '';
    let addressLength = 0;
    let addressValueIndex = startIndex;
    switch (type) {
        case 1:
            addressLength = 4;
            addressValue = Array.from(new Uint8Array(buffer.slice(addressValueIndex, addressValueIndex + addressLength)))
                .join('.');
            break;
        case 2:
            addressLength = view.getUint8(addressValueIndex);
            addressValueIndex += 1;
            addressValue = new TextDecoder().decode(buffer.slice(addressValueIndex, addressValueIndex + addressLength));
            break;
        case 3:
            addressLength = 16;
            addressValue = Array.from({ length: 8 }, (_, i) => view.getUint16(addressValueIndex + i * 2).toString(16))
                .join(':');
            break;
        default:
            addressValue = '';
    }
    return { addressValue, addressValueIndex, addressLength };
}

async function forwardDataToWebSocket(remoteSocket, webSocket, vlessResponseHeader, retry) {
    let hasIncomingData = false;
    const handleChunk = async (chunk) => {
        hasIncomingData = true;
        if (webSocket.readyState !== WebSocket.OPEN) {
            throw new Error('WebSocket is not open');
        }
        if (vlessResponseHeader) {
            const combinedData = new Uint8Array(vlessResponseHeader.byteLength + chunk.byteLength);
            combinedData.set(new Uint8Array(vlessResponseHeader), 0);
            combinedData.set(new Uint8Array(chunk), vlessResponseHeader.byteLength);
            webSocket.send(combinedData.buffer);
            vlessResponseHeader = null;
        } else {
            webSocket.send(chunk);
        }
    };
    try {
        await remoteSocket.readable.pipeTo(new WritableStream({ write: handleChunk }));
    } catch {
        closeWebSocketSafely(webSocket);
    }
    if (!hasIncomingData && retry) {
        retry();
    }
}

function base64ToArrayBuffer(base64Str) {
    if (!base64Str) return { earlyData: null, error: null };
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
        return { earlyData: null, error };
    }
}

function closeWebSocketSafely(socket) {
    if ([WebSocket.OPEN, WebSocket.CLOSING].includes(socket.readyState)) {
        try {
            socket.close();
        } catch (error) {
        }
    }
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
    const writableStream = new WritableStream({
        async write(chunk) {
            const dnsResult = await dnsFetch(chunk);
            const udpSizeBuffer = new Uint8Array([
                (dnsResult.byteLength >> 8) & 0xff, 
                dnsResult.byteLength & 0xff
            ]);

            if (webSocket.readyState === WebSocket.OPEN) {
                const combinedData = new Uint8Array([
                    ...(isHeaderSent ? [] : vlessResponseHeader),
                    ...udpSizeBuffer, 
                    ...new Uint8Array(dnsResult)
                ]);

                webSocket.send(combinedData.buffer);
                isHeaderSent = true;
            }
        }
    });

    transformStream.readable.pipeTo(writableStream);
}

function getVLESSConfig(userID, hostName) {
    return `
################################################################
---------------------------------------------------------------
vless://${userID}\u0040${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&alpn=h3&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}
---------------------------------------------------------------
################################################################
`;
}
