import { connect } from 'cloudflare:sockets';

const isValidUUID = uuid =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid);

const handleVlessHeader = (buffer, userID) => {
    const view = new DataView(buffer);
    const version = buffer.slice(0, 1);
    const isInvalidUUID = stringify(new Uint8Array(buffer.slice(1, 17))) !== userID;

    if (buffer.byteLength < 24 || isInvalidUUID) return { hasError: true };

    const optLength = view.getUint8(17);
    const command = view.getUint8(18 + optLength);

    if (![1, 2].includes(command)) return { hasError: true };

    const isUDP = (command === 2);
    const portRemote = view.getUint16(18 + optLength + 1);
    const { addressRemote, rawDataIndex } = getAddress(view, 18 + optLength + 3);

    return { hasError: false, addressRemote, portRemote, rawDataIndex, version, isUDP };
};

const getAddress = (view, index) => {
    const addressType = view.getUint8(index - 1);
    let address = '', length = 0;

    switch (addressType) {
        case 1: length = 4; address = Array.from(new Uint8Array(view.buffer.slice(index, index + length))).join('.'); break;
        case 2: length = view.getUint8(index); address = new TextDecoder().decode(view.buffer.slice(index + 1, index + 1 + length)); break;
        case 3: length = 16; address = Array.from({ length: 8 }, (_, i) => view.getUint16(index + i * 2).toString(16)).join(':'); break;
        default: return { address: '', length: 0, rawDataIndex: index };
    }
    return { addressRemote: address, rawDataIndex: index + length };
};

const safeCloseWebSocket = socket => {
    if ([WebSocket.OPEN, WebSocket.CLOSING].includes(socket.readyState)) socket.close();
};

export default {
    async fetch(request, env) {
        try {
            const userID = env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4';
            const proxyIP = env.PROXYIP || '';

            if (!isValidUUID(userID)) throw new Error('uuid is not valid');

            const upgradeHeader = request.headers.get('Upgrade');

            if (!upgradeHeader || upgradeHeader !== 'websocket') {
                return await handleHttpRequest(request, userID);
            }

            return await handleWebSocketRequest(request, userID, proxyIP);
        } catch (err) {
            return new Response(err.toString());
        }
    },
};

const handleHttpRequest = async (request, userID) => {
    const url = new URL(request.url);

    switch (url.pathname) {
        case '/':
            return new Response(JSON.stringify(request.cf, null, 4), { status: 200 });
        case `/${userID}`:
            return new Response(getVLESSConfig(userID, request.headers.get('Host')), {
                status: 200,
                headers: { "Content-Type": "text/plain;charset=utf-8", "Alt-Svc": 'h3-23=":443"; ma=86400, h3-22=":443"; ma=86400, h3-21=":443"; ma=86400' }
            });
        default:
            return new Response('Not found', { status: 404 });
    }
};

const handleWebSocketRequest = async (request, userID, proxyIP) => {
    const { 0: client, 1: webSocket } = new WebSocketPair();
    webSocket.accept();
    const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
    const readableStream = makeReadableWebSocketStream(webSocket, earlyDataHeader);

    await processStream(readableStream, webSocket, userID, proxyIP);

    return new Response(null, { status: 101, webSocket: client });
};

const processStream = async (stream, webSocket, userID, proxyIP) => {
    const remoteSocketWrapper = { value: null };
    let udpStreamWrite = null, isDns = false;

    await stream.pipeTo(new WritableStream({
        async write(chunk) {
            if (isDns && udpStreamWrite) {
                return udpStreamWrite(chunk);
            }

            if (remoteSocketWrapper.value) {
                const writer = remoteSocketWrapper.value.writable.getWriter();
                await writer.write(chunk);
                writer.releaseLock();
                return;
            }

            const { hasError, addressRemote, portRemote, rawDataIndex, version, isUDP } = handleVlessHeader(chunk, userID);
            if (hasError) return;

            if (isUDP && portRemote === 53) {
                isDns = true;
            } else if (!isUDP) {
                handleTCPOutBound(remoteSocketWrapper, addressRemote, portRemote, chunk.slice(rawDataIndex), webSocket, new Uint8Array([version[0], 0]));
                return;
            }

            if (isDns) {
                const { write } = await handleUDPOutBound(webSocket, new Uint8Array([version[0], 0]));
                udpStreamWrite = write;
                udpStreamWrite(chunk.slice(rawDataIndex));
            }
        }
    })).catch(() => {});
};

const handleTCPOutBound = async (remoteSocket, address, port, rawData, webSocket, header) => {
    const connectAndWrite = async (addr, prt) => {
        if (remoteSocket.value && !remoteSocket.value.closed) {
            const writer = remoteSocket.value.writable.getWriter();
            await writer.write(rawData);
            writer.releaseLock();
            return remoteSocket.value;
        }

        const quicSocket = connect({ hostname: addr, port: prt, protocol: 'quic' });
        remoteSocket.value = quicSocket;
        const writer = quicSocket.writable.getWriter();
        await writer.write(rawData);
        writer.releaseLock();
        return quicSocket;
    };

    const quicSocket = await connectAndWrite(address, port);
    remoteSocketToWS(quicSocket, webSocket, header, async () => {
        const fallbackSocket = await connectAndWrite(proxyIP || address, port);
        fallbackSocket.closed.catch(() => {}).finally(() => safeCloseWebSocket(webSocket));
        remoteSocketToWS(fallbackSocket, webSocket, header);
    });
};

const remoteSocketToWS = async (remoteSocket, webSocket, header, retry) => {
    let hasIncomingData = false;

    try {
        await remoteSocket.readable.pipeTo(new WritableStream({
            async write(chunk) {
                hasIncomingData = true;
                if (webSocket.readyState === WebSocket.OPEN) {
                    const data = header ? new Blob([header, chunk]).arrayBuffer() : chunk;
                    webSocket.send(await data);
                    header = null;
                }
            }
        }));
    } catch {
        safeCloseWebSocket(webSocket);
    }

    if (!hasIncomingData && retry) retry();
};

const makeReadableWebSocketStream = (webSocket, earlyDataHeader) => new ReadableStream({
    start(controller) {
        webSocket.addEventListener('message', event => controller.enqueue(event.data));
        webSocket.addEventListener('close', () => controller.close());
        webSocket.addEventListener('error', err => controller.error(err));

        const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
        if (error) {
            controller.error(error);
        } else if (earlyData) {
            controller.enqueue(earlyData);
        }
    },
    cancel() { safeCloseWebSocket(webSocket); }
});

const base64ToArrayBuffer = base64Str => {
    try {
        if (!base64Str) return { error: null };
        const decode = atob(base64Str.replace(/-/g, '+').replace(/_/g, '/'));
        return { earlyData: Uint8Array.from(decode, c => c.charCodeAt(0)).buffer, error: null };
    } catch (error) {
        return { error };
    }
};

const getVLESSConfig = (userID, hostName) =>
    `vless://${userID}\u0040${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;

const stringify = arr => unsafeStringify(arr);
const unsafeStringify = (arr, offset = 0) =>
    arr.slice(offset, offset + 16).map(b => b.toString(16).padStart(2, '0')).join('');
