import { connect } from 'cloudflare:sockets';

let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let proxyIP = '';

if (!isValidUUID(userID)) {
    throw new Error('UUID is not valid');
}

export default {
    async fetch(request, env, ctx) {
        try {
            userID = env.UUID || userID;
            proxyIP = env.PROXYIP || proxyIP;
            const upgradeHeader = request.headers.get('Upgrade');
            if (upgradeHeader === 'websocket') {
                return await vlessOverWSHandler(request);
            }
            const url = new URL(request.url);
            switch (url.pathname) {
                case '/':
                    return new Response(JSON.stringify(request.cf, null, 4), { status: 200 });
                case `/${userID}`:
                    const vlessConfig = getVLESSConfig(userID, request.headers.get('Host'));
                    return new Response(vlessConfig, { status: 200, headers: { "Content-Type": "text/plain;charset=utf-8" } });
                default:
                    url.hostname = 'www.bing.com';
                    url.protocol = 'https:';
                    return await fetch(new Request(url, request));
            }
        } catch (err) {
            return new Response(err.toString());
        }
    },
};

async function vlessOverWSHandler(request) {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    webSocket.accept();
    let isDns = false;
    const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
    const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader);
    const { write: udpStreamWrite } = isDns ? await handleUDPOutBound(webSocket) : {};
    readableWebSocketStream.pipeTo(new WritableStream({
        async write(chunk) {
            if (isDns && udpStreamWrite) {
                return udpStreamWrite(chunk);
            }
            const { hasError, message, portRemote = 443, addressRemote = '', rawDataIndex, vlessVersion = new Uint8Array([0, 0]), isUDP } = processVlessHeader(chunk, userID);          
            if (hasError) throw new Error(message);           
            if (isUDP) {
                if (portRemote === 53) {
                    isDns = true;
                } else {
                    throw new Error('UDP proxy only enabled for DNS on port 53');
                }
            }
            const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
            const rawClientData = chunk.slice(rawDataIndex);
            if (isDns) {
                udpStreamWrite(rawClientData);
            } else {
                handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader);
            }
        },
    })).catch(() => safeCloseWebSocket(webSocket));
    return new Response(null, { status: 101, webSocket: client });
}

async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader) {
    async function connectAndWrite(address, port) {
        const tcpSocket = connect({ hostname: address, port });
        const writer = tcpSocket.writable.getWriter();
        await writer.write(rawClientData);
        writer.releaseLock();
        return tcpSocket;
    }
    async function retry() {
        const tcpSocket = await connectAndWrite(proxyIP || addressRemote, portRemote);
        tcpSocket.closed.catch(() => {}).finally(() => safeCloseWebSocket(webSocket));
        remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, null);
    }
    const tcpSocket = await connectAndWrite(addressRemote, portRemote);
    remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retry);
}

function makeReadableWebSocketStream(webSocketServer, earlyDataHeader) {
    const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);   
    if (error) return new ReadableStream({ start(controller) { controller.error(error); } });
    const stream = new ReadableStream({
        start(controller) {
            webSocketServer.addEventListener('message', (event) => controller.enqueue(event.data));
            webSocketServer.addEventListener('close', () => {
                safeCloseWebSocket(webSocketServer);
                controller.close();
            });
            webSocketServer.addEventListener('error', (err) => controller.error(err));

            if (earlyData) controller.enqueue(earlyData);
        },
        cancel() {
            safeCloseWebSocket(webSocketServer);
        }
    });
    return stream;
}

function processVlessHeader(vlessBuffer, userID) {
    if (vlessBuffer.byteLength < 24) return { hasError: true };
    const version = new Uint8Array(vlessBuffer.slice(0, 1));
    const userIdBuffer = vlessBuffer.slice(1, 17);
    if (stringify(userIdBuffer) !== userID) return { hasError: true };
    const optLength = vlessBuffer[17];
    const command = vlessBuffer[18 + optLength];
    const isUDP = command === 2;
    const portRemote = new DataView(vlessBuffer.slice(18 + optLength + 1, 20 + optLength)).getUint16(0);
    let addressIndex = 21 + optLength;
    const addressType = vlessBuffer[addressIndex - 1];
    const { addressValue, addressLength } = getAddress(addressType, vlessBuffer.slice(addressIndex));
    if (!addressValue) return { hasError: true };
    return {
        hasError: false,
        addressRemote: addressValue,
        portRemote,
        rawDataIndex: addressIndex + addressLength,
        vlessVersion: version,
        isUDP
    };
}

function getAddress(addressType, buffer) {
    switch (addressType) {
        case 1:
            return {
                addressValue: Array.from(buffer.slice(0, 4)).join('.'),
                addressLength: 4
            };
        case 2:
            const length = buffer[0];
            return {
                addressValue: new TextDecoder().decode(buffer.slice(1, 1 + length)),
                addressLength: length + 1
            };
        case 3:
            const ipv6 = Array.from(new DataView(buffer.slice(0, 16)).buffer).map((_, i) => (i % 2 === 0 ? buffer[i] : '')).join(':');
            return {
                addressValue: ipv6,
                addressLength: 16
            };
        default:
            return { addressValue: null, addressLength: 0 };
    }
}

async function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, retry) {
    let hasIncomingData = false;
    const vlessHeader = vlessResponseHeader;
    await remoteSocket.readable.pipeTo(new WritableStream({
        async write(chunk) {
            hasIncomingData = true;
            if (webSocket.readyState === WS_READY_STATE_OPEN) {
                const data = vlessHeader ? await new Blob([vlessHeader, chunk]).arrayBuffer() : chunk;
                webSocket.send(data);
                vlessHeader = null;
            } else {
                throw new Error('WebSocket is not open');
            }
        },
    })).catch(() => safeCloseWebSocket(webSocket));
    if (!hasIncomingData && retry) retry();
}

function base64ToArrayBuffer(base64Str) {
    if (!base64Str) return { error: null };
    try {
        base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
        const decoded = atob(base64Str);
        const arrayBuffer = Uint8Array.from(decoded, c => c.charCodeAt(0)).buffer;
        return { earlyData: arrayBuffer, error: null };
    } catch (error) {
        return { error };
    }
}

function isValidUUID(uuid) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
}

function safeCloseWebSocket(socket) {
    try {
        if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
            socket.close();
        }
    } catch {}
}

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
const byteToHex = Array.from({ length: 256 }, (_, i) => (i + 256).toString(16).slice(1));

function unsafeStringify(arr, offset = 0) {
    return Array.from({ length: 16 }, (_, i) => byteToHex[arr[offset + i]]).join('').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5').toLowerCase();
}

function stringify(arr, offset = 0) {
    const uuid = unsafeStringify(arr, offset);
    if (!isValidUUID(uuid)) {
        throw new Error("Invalid UUID provided");
    }
    return uuid;
}

function getVLESSConfig(userID, hostName) {
    return `
################################################################
v2ray
---------------------------------------------------------------
vless://${userID}\u0040${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}
---------------------------------------------------------------
################################################################
`;
}
