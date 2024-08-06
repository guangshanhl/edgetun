import { connect } from 'cloudflare:sockets';

export default {
    async fetch(request, env) {
        try {
            const userID = env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4';
            const proxyIP = env.PROXYIP || '';
            return request.headers.get('Upgrade') === 'websocket'
                ? handleWebSocket(request, userID, proxyIP)
                : handleNonWebSocketRequest(request, userID);
        } catch (err) {
            return new Response('Internal Server Error', { status: 500 });
        }
    },
};

async function handleNonWebSocketRequest(request, userID) {
    const url = new URL(request.url);
    const host = request.headers.get('Host');
    switch (url.pathname) {
        case '/':
            return new Response(JSON.stringify(request.cf, null, 4), { status: 200 });
        case `/${userID}`:
            return new Response(getVLESSConfig(userID, host), {
                status: 200,
                headers: {
                    "Content-Type": "text/plain;charset=utf-8",
                    "Alt-Svc": 'h3=":443"; ma=86400'
                }
            });
        default:
            return new Response('Not found', { status: 404 });
    }
}

async function handleWebSocket(request, userID, proxyIP) {
    const [client, webSocket] = new WebSocketPair();
    webSocket.accept();
    const readableStream = createReadableWebSocketStream(webSocket, request.headers.get('sec-websocket-protocol') || '');
    let remoteSocket = { value: null }, udpStreamWrite = null, isDns = false;

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
            if (isUDP && portRemote === 53) isDns = true;
            if (isUDP) return;
            const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
            const rawClientData = chunk.slice(rawDataIndex);
            if (isDns) {
                udpStreamWrite = await handleUDPOutbound(webSocket, vlessResponseHeader, rawClientData);
            } else {
                handleQUICOutbound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, proxyIP);
            }
        }
    })).catch(() => {});
    return new Response(null, { status: 101, webSocket: client });
}

async function handleQUICOutbound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, proxyIP) {
    const quicSocket = connect({ hostname: addressRemote, port: portRemote, protocol: 'quic' });
    remoteSocket.value = quicSocket;
    const writer = quicSocket.writable.getWriter();
    try {
        await writer.write(rawClientData);
        writer.releaseLock();
        await forwardDataToWebSocket(quicSocket, webSocket, vlessResponseHeader, () => connectAndForward(addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, proxyIP));
    } catch {
        closeWebSocketSafely(webSocket);
    }
}

async function connectAndForward(addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, proxyIP) {
    const fallbackSocket = await connect({ hostname: proxyIP || addressRemote, port: portRemote, protocol: 'quic' });
    fallbackSocket.closed.catch(() => {}).finally(() => closeWebSocketSafely(webSocket));
    await forwardDataToWebSocket(fallbackSocket, webSocket, vlessResponseHeader);
}

function createReadableWebSocketStream(webSocket, earlyDataHeader) {
    let isCancelled = false;
    return new ReadableStream({
        start(controller) {
            webSocket.addEventListener('message', event => !isCancelled && controller.enqueue(event.data));
            webSocket.addEventListener('close', () => controller.close());
            webSocket.addEventListener('error', err => controller.error(err));
            const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
            if (error) controller.error(error);
            else if (earlyData) controller.enqueue(earlyData);
        },
        cancel() {
            isCancelled = true;
            closeWebSocketSafely(webSocket);
        }
    });
}

function processVlessHeader(buffer, userID) {
    const view = new DataView(buffer);
    const optLength = view.getUint8(17);
    const command = view.getUint8(18 + optLength);
    const isUDP = command === 2;
    const portRemote = view.getUint16(18 + optLength + 1);
    const addressIndex = 18 + optLength + 3;
    const addressType = view.getUint8(addressIndex);
    const addressLength = addressType === 2 ? view.getUint8(addressIndex + 1) : (addressType === 1 ? 4 : 16);
    const addressValueIndex = addressIndex + (addressType === 2 ? 2 : 1);
    let addressValue;

    if (addressType === 1) {
        addressValue = Array.from(new Uint8Array(buffer, addressValueIndex, 4)).join('.');
    } else if (addressType === 2) {
        addressValue = new TextDecoder().decode(new Uint8Array(buffer, addressValueIndex, addressLength));
    } else if (addressType === 3) {
        addressValue = Array.from(new Uint8Array(buffer, addressValueIndex, 16))
            .map(b => b.toString(16).padStart(2, '0'))
            .join(':');
    }

    return { addressRemote: addressValue, portRemote, rawDataIndex: addressValueIndex + addressLength, vlessVersion: [0], isUDP };
}

async function forwardDataToWebSocket(remoteSocket, webSocket, vlessResponseHeader, retry) {
    let hasIncomingData = false;
    try {
        await remoteSocket.readable.pipeTo(new WritableStream({
            async write(chunk) {
                hasIncomingData = true;
                if (webSocket.readyState !== WebSocket.OPEN) throw new Error('WebSocket is not open');
                webSocket.send(vlessResponseHeader ? new Uint8Array([...vlessResponseHeader, ...new Uint8Array(chunk)]).buffer : chunk);
                vlessResponseHeader = null;
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
        const binaryString = atob(base64Str.replace(/-/g, '+').replace(/_/g, '/'));
        return { earlyData: new Uint8Array([...binaryString].map(char => char.charCodeAt(0))).buffer, error: null };
    } catch (error) {
        return { error };
    }
}

function closeWebSocketSafely(socket) {
    if ([WebSocket.OPEN, WebSocket.CLOSING].includes(socket.readyState)) {
        try { socket.close(); } catch (error) {}
    }
}

function getVLESSConfig(userID, hostName) {
    return `
vless://${userID}\u0040${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}';
}
