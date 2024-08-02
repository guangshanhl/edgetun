import { connect } from 'cloudflare:sockets';

export default {
    async fetch(request, env) {
        try {
            const userID = env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4';
            const proxyIP = env.PROXYIP || '';
            const upgradeHeader = request.headers.get('Upgrade');
            if (upgradeHeader === 'websocket') {
                return await handleWebSocket(request, userID, proxyIP);
            }
            return handleNonWebSocketRequest(request, userID);
        } catch (err) {
            return new Response(err.toString(), { status: 500 });
        }
    },
};

async function handleNonWebSocketRequest(request, userID) {
    const url = new URL(request.url);
    switch (url.pathname) {
        case '/':
            return new Response(JSON.stringify(request.cf, null, 4), { status: 200 });
        case `/${userID}`:
            return new Response(getVLESSConfig(userID, request.headers.get('Host')), {
                status: 200,
                headers: { "Content-Type": "text/plain;charset=utf-8" }
            });
        default:
            url.hostname = 'bing.com';
            url.protocol = 'https:';
            return await fetch(new Request(url, request));
    }
}

async function handleWebSocket(request, userID, proxyIP) {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = webSocketPair;
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
                handleTCPOutbound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, proxyIP);
            }
        },
    }));

    return new Response(null, { status: 101, webSocket: client });
}

async function handleTCPOutbound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, proxyIP) {
    const tcpSocket = await connect({ hostname: proxyIP || addressRemote, port: portRemote });
    remoteSocket.value = tcpSocket;

    const writer = tcpSocket.writable.getWriter();
    await writer.write(rawClientData);
    writer.releaseLock();

    forwardDataToWebSocket(tcpSocket, webSocket, vlessResponseHeader);
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

    const optLength = vlessBuffer[17];
    const command = vlessBuffer[18 + optLength];
    if (![1, 2].includes(command)) return { hasError: true };

    const isUDP = command === 2;
    const portRemote = new DataView(vlessBuffer.slice(18 + optLength + 1, 20 + optLength)).getUint16(0);
    const addressType = vlessBuffer[20 + optLength];
    
    let addressValue = '';
    let addressLength = 0;
    let addressValueIndex = 21 + optLength;

    switch (addressType) {
        case 1:
            addressLength = 4;
            addressValue = Array.from(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength))
                .join('.');
            break;
        case 2:
            addressLength = vlessBuffer[addressValueIndex];
            addressValueIndex += 1;
            addressValue = new TextDecoder().decode(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
            break;
        case 3:
            addressLength = 16;
            addressValue = Array.from(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength))
                .map(byte => byte.toString(16).padStart(2, '0'))
                .join(':');
            break;
        default:
            return { hasError: true };
    }

    return {
        hasError: false,
        addressRemote: addressValue,
        portRemote,
        rawDataIndex: addressValueIndex + addressLength,
        vlessVersion: version,
        isUDP
    };
}

async function forwardDataToWebSocket(remoteSocket, webSocket, vlessResponseHeader) {
    let hasIncomingData = false;
    try {
        await remoteSocket.readable.pipeTo(new WritableStream({
            async write(chunk) {
                hasIncomingData = true;
                if (webSocket.readyState !== WebSocket.OPEN) throw new Error('WebSocket is not open');
                
                const dataToSend = vlessResponseHeader
                    ? await new Blob([vlessResponseHeader, chunk]).arrayBuffer()
                    : chunk;

                webSocket.send(dataToSend);
                vlessResponseHeader = null;
            }
        }));
    } catch {
        closeWebSocketSafely(webSocket);
    }
    if (!hasIncomingData) {
        closeWebSocketSafely(webSocket);
    }
}

function base64ToArrayBuffer(base64Str) {
    if (!base64Str) return { error: null };
    try {
        base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
        return { earlyData: Uint8Array.from(atob(base64Str), c => c.charCodeAt(0)).buffer, error: null };
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
            for (let index = 0; index < chunk.byteLength;) {
                const udpPacketLength = new DataView(chunk.slice(index, index + 2)).getUint16(0);
                controller.enqueue(chunk.slice(index + 2, index + 2 + udpPacketLength));
                index += 2 + udpPacketLength;
            }
        }
    });

    transformStream.readable.pipeTo(new WritableStream({
        async write(chunk) {
            const response = await fetch('https://cloudflare-dns.com/dns-query', {
                method: 'POST',
                headers: { 'content-type': 'application/dns-message' },
                body: chunk
            });
            const dnsResult = await response.arrayBuffer();
            const udpSizeBuffer = new Uint8Array([(dnsResult.byteLength >> 8) & 0xff, dnsResult.byteLength & 0xff]);

            if (webSocket.readyState === WebSocket.OPEN) {
                const blobParts = isHeaderSent
                    ? [udpSizeBuffer, dnsResult]
                    : [vlessResponseHeader, udpSizeBuffer, dnsResult];
                webSocket.send(await new Blob(blobParts).arrayBuffer());
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
