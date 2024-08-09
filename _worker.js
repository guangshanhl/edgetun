import { connect } from 'cloudflare:sockets';

let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let proxyIP = '';

const isValidUUID = uuid => /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid);
if (!isValidUUID(userID)) throw new Error('UUID is not valid');

export default {
    async fetch(request, env) {
        try {
            userID = env.UUID || userID;
            proxyIP = env.PROXYIP || proxyIP;

            const upgradeHeader = request.headers.get('Upgrade');
            if (upgradeHeader === 'websocket') return await handleWebSocket(request);

            const url = new URL(request.url);
            return url.pathname === '/'
                ? new Response(JSON.stringify(request.cf, null, 4), { status: 200 })
                : url.pathname === `/${userID}`
                ? new Response(getVLESSConfig(userID, request.headers.get('Host')), {
                    status: 200,
                    headers: {
                        "Content-Type": "text/plain;charset=utf-8",
                        "Alt-Svc": 'h3-23=":443"; ma=86400, h3-22=":443"; ma=86400, h3-21=":443"; ma=86400'
                    }
                })
                : new Response('Not found', { status: 404 });
        } catch (err) {
            return new Response(err.toString());
        }
    },
};

async function handleWebSocket(request) {
    const { 0: client, 1: webSocket } = new WebSocketPair();
    webSocket.accept();

    const readableWebSocketStream = makeReadableWebSocketStream(webSocket, request.headers.get('sec-websocket-protocol') || '');
    let remoteSocketWrapper = { value: null }, udpStreamWrite = null, isDns = false;

    readableWebSocketStream.pipeTo(new WritableStream({
        async write(chunk) {
            if (isDns && udpStreamWrite) return udpStreamWrite(chunk);
            if (remoteSocketWrapper.value) return writeToRemoteSocket(remoteSocketWrapper.value, chunk);

            const { hasError, addressRemote, portRemote, rawDataIndex, vlessVersion, isUDP } = processVlessHeader(chunk, userID);
            if (hasError) return;

            if (isUDP && portRemote === 53) isDns = true;
            else return handleTCPOutBound(remoteSocketWrapper, addressRemote, portRemote, chunk.slice(rawDataIndex), webSocket, vlessVersion);

            if (isDns) {
                const { write } = await handleUDPOutBound(webSocket, vlessVersion);
                udpStreamWrite = write;
                udpStreamWrite(chunk.slice(rawDataIndex));
            }
        },
    })).catch(() => {});

    return new Response(null, { status: 101, webSocket: client });
}

const writeToRemoteSocket = async (socket, chunk) => {
    const writer = socket.writable.getWriter();
    await writer.write(chunk);
    writer.releaseLock();
};

async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessVersion) {
    const connectAndWrite = async (address, port) => {
        const socket = remoteSocket.value && !remoteSocket.value.closed
            ? remoteSocket.value
            : connect({ hostname: address, port, protocol: 'quic' });

        remoteSocket.value = socket;
        await writeToRemoteSocket(socket, rawClientData);
        return socket;
    };

    const quicSocket = await connectAndWrite(addressRemote, portRemote);
    remoteSocketToWS(quicSocket, webSocket, vlessVersion, async () => {
        const fallbackSocket = await connectAndWrite(proxyIP || addressRemote, portRemote);
        fallbackSocket.closed.catch(() => {}).finally(() => safeCloseWebSocket(webSocket));
        remoteSocketToWS(fallbackSocket, webSocket, vlessVersion);
    });
}

const makeReadableWebSocketStream = (webSocketServer, earlyDataHeader) => new ReadableStream({
    start(controller) {
        webSocketServer.addEventListener('message', event => controller.enqueue(event.data));
        webSocketServer.addEventListener('close', () => controller.close());
        webSocketServer.addEventListener('error', err => controller.error(err));

        const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
        if (error) controller.error(error);
        else if (earlyData) controller.enqueue(earlyData);
    },
    cancel() {
        safeCloseWebSocket(webSocketServer);
    }
});

const processVlessHeader = (vlessBuffer, userID) => {
    const view = new DataView(vlessBuffer);
    if (vlessBuffer.byteLength < 24 || stringify(vlessBuffer.slice(1, 17)) !== userID) return { hasError: true };

    const optLength = view.getUint8(17);
    const command = view.getUint8(18 + optLength);
    if (![1, 2].includes(command)) return { hasError: true };

    const portRemote = view.getUint16(18 + optLength + 1);
    const addressData = extractAddress(vlessBuffer, view, 18 + optLength + 3);

    return {
        hasError: false,
        addressRemote: addressData.addressRemote,
        portRemote,
        rawDataIndex: 18 + optLength + 3 + addressData.addressLength,
        vlessVersion: vlessBuffer.slice(0, 1),
        isUDP: command === 2,
    };
};

const extractAddress = (buffer, view, offset) => {
    const addressType = view.getUint8(offset);
    let addressRemote = '', addressLength = 0;
    if (addressType === 1) {
        addressRemote = Array.from(new Uint8Array(buffer.slice(offset + 1, offset + 5))).join('.');
        addressLength = 4;
    } else if (addressType === 2) {
        addressLength = view.getUint8(offset + 1);
        addressRemote = new TextDecoder().decode(buffer.slice(offset + 2, offset + 2 + addressLength));
    } else if (addressType === 3) {
        addressLength = 16;
        addressRemote = Array.from({ length: 8 }, (_, i) => view.getUint16(offset + 1 + i * 2).toString(16)).join(':');
    } else {
        return { addressRemote: '', addressLength: 0 };
    }

    return { addressRemote, addressLength };
};

async function remoteSocketToWS(remoteSocket, webSocket, vlessVersion, retry) {
    let hasIncomingData = false;
    try {
        await remoteSocket.readable.pipeTo(new WritableStream({
            async write(chunk) {
                hasIncomingData = true;
                if (webSocket.readyState === WebSocket.OPEN) {
                    webSocket.send(vlessVersion ? await new Blob([vlessVersion, chunk]).arrayBuffer() : chunk);
                    vlessVersion = null;
                }
            }
        }));
    } catch {
        safeCloseWebSocket(webSocket);
    }
    if (!hasIncomingData && retry) retry();
}

const base64ToArrayBuffer = base64Str => {
    if (!base64Str) return { error: null };
    try {
        const decodedStr = atob(base64Str.replace(/-/g, '+').replace(/_/g, '/'));
        return { earlyData: Uint8Array.from(decodedStr, c => c.charCodeAt(0)).buffer, error: null };
    } catch (error) {
        return { error };
    }
};

const safeCloseWebSocket = socket => {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING) socket.close();
};

const stringify = arr => {
    const uuid = unsafeStringify(arr);
    if (!isValidUUID(uuid)) throw new TypeError("Stringified UUID is invalid");
    return uuid;
};

const getVLESSConfig = (userID, hostName) => `
vless://${userID}@${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
