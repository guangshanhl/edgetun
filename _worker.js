import { connect } from 'cloudflare:sockets';
let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let proxyIP = '';
export default {
    async fetch(request, env) {
        try {
            userID = env.UUID || userID;
            proxyIP = env.PROXYIP || proxyIP;
            const upgradeHeader = request.headers.get('Upgrade');
            if (upgradeHeader !== 'websocket') {
                return handleHttpRequest(request);
            } else {
                return await vlessOverWSHandler(request);
            }
        } catch (err) {
            return new Response(err.toString());
        }
    },
};
async function handleHttpRequest(request) {
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
            url.hostname = 'www.bing.com';
            url.protocol = 'https:';
            return await fetch(new Request(url, request));
    }
}
async function vlessOverWSHandler(request) {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    webSocket.accept();
    const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
    const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader);
    const remoteSocketWapper = { value: null };
    let udpStreamWrite = null, isDns = false;
    readableWebSocketStream.pipeTo(new WritableStream({
        async write(chunk) {
            if (isDns && udpStreamWrite) return udpStreamWrite(chunk);
            if (remoteSocketWapper.value) {
                const writer = remoteSocketWapper.value.writable.getWriter();
                await writer.write(chunk);
                writer.releaseLock();
                return;
            }
            const { hasError, addressRemote, portRemote, rawDataIndex, vlessVersion, isUDP } = processVlessHeader(chunk, userID);
            if (hasError) return;           
            if (isUDP && (portRemote === 53)) {
                isDns = true;
            } else if (isUDP) {
                return;
            }
            const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
            const rawClientData = chunk.slice(rawDataIndex);
            if (isDns) {
                const { write } = await handleUDPOutBound(webSocket, vlessResponseHeader);
                udpStreamWrite = write;
                udpStreamWrite(rawClientData);
                return;
            }
            handleTCPOutBound(remoteSocketWapper, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader);
        },
    })).catch(() => {});
    return new Response(null, { status: 101, webSocket: client });
}
async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader) {
    async function connectAndWrite(address, port) {
        const tcpSocket = connect({ hostname: address, port });
        remoteSocket.value = tcpSocket;
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
function makeReadableWebSocketStream(webSocket, earlyDataHeader) {
    let readableStreamCancel = false;
    return new ReadableStream({
        start(controller) {
            webSocket.addEventListener('message', event => !readableStreamCancel && controller.enqueue(event.data));
            webSocket.addEventListener('close', () => controller.close());
            webSocket.addEventListener('error', err => controller.error(err));

            const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
            if (error) return controller.error(error);
            if (earlyData) controller.enqueue(earlyData);
        },
        cancel() {
            readableStreamCancel = true;
            safeCloseWebSocket(webSocket);
        }
    });
}
function processVlessHeader(vlessBuffer, userID) {
    if (vlessBuffer.byteLength < 24) return { hasError: true };
    const version = new Uint8Array(vlessBuffer.slice(0, 1));
    const isValidUser = stringify(new Uint8Array(vlessBuffer.slice(1, 17))) === userID;
    if (!isValidUser) return { hasError: true };
    const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
    const command = new Uint8Array(vlessBuffer.slice(18 + optLength, 18 + optLength + 1))[0];
    const isUDP = command === 2;
    if (![1, 2].includes(command)) return { hasError: true };
    const portIndex = 18 + optLength + 1;
    const portRemote = new DataView(vlessBuffer.slice(portIndex, portIndex + 2)).getUint16(0);
    const addressIndex = portIndex + 2;
    const addressType = new Uint8Array(vlessBuffer.slice(addressIndex, addressIndex + 1))[0];
    let addressValue = '';
    switch (addressType) {
        case 1:
            addressValue = new Uint8Array(vlessBuffer.slice(addressIndex + 1, addressIndex + 5)).join('.');
            break;
        case 2:
            const domainLength = new Uint8Array(vlessBuffer.slice(addressIndex + 1, addressIndex + 2))[0];
            addressValue = new TextDecoder().decode(vlessBuffer.slice(addressIndex + 2, addressIndex + 2 + domainLength));
            break;
        case 3:
            addressValue = Array.from({ length: 8 }, (_, i) => new DataView(vlessBuffer.slice(addressIndex + 1, addressIndex + 17)).getUint16(i * 2).toString(16)).join(':');
            break;
        default:
            return { hasError: true };
    }
    if (!addressValue) return { hasError: true };
    return {
        hasError: false,
        addressRemote: addressValue,
        portRemote,
        rawDataIndex: addressIndex + 1 + (addressType === 2 ? domainLength + 1 : (addressType === 1 ? 4 : 16)),
        vlessVersion: version,
        isUDP
    };
}
async function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, retry) {
    let hasIncomingData = false;
    await remoteSocket.readable.pipeTo(new WritableStream({
        async write(chunk) {
            hasIncomingData = true;
            if (webSocket.readyState !== WS_READY_STATE_OPEN) throw new Error('readyState is not open');
            webSocket.send(vlessResponseHeader ? await new Blob([vlessResponseHeader, chunk]).arrayBuffer() : chunk);
            vlessResponseHeader = null;
        }
    })).catch(() => safeCloseWebSocket(webSocket));
    if (!hasIncomingData && retry) retry();
}
function base64ToArrayBuffer(base64Str) {
    if (!base64Str) return { error: null };
    try {
        base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
        const arrayBuffer = Uint8Array.from(atob(base64Str), c => c.charCodeAt(0)).buffer;
        return { earlyData: arrayBuffer, error: null };
    } catch (error) {
        return { error };
    }
}
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
function safeCloseWebSocket(socket) {
    try {
        if ([WS_READY_STATE_OPEN, WS_READY_STATE_CLOSING].includes(socket.readyState)) {
            socket.close();
        }
    } catch {}
}
function stringify(arr) {
    const byteToHex = Array.from({ length: 256 }, (_, i) => (i + 256).toString(16).slice(1));
    return Array.from({ length: 16 }, (_, i) => byteToHex[arr[i]]).join('').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5').toLowerCase();
}
async function handleUDPOutBound(webSocket, vlessResponseHeader) {
    let isVlessHeaderSent = false;
    const transformStream = new TransformStream({
        transform(chunk, controller) {
            for (let index = 0; index < chunk.byteLength;) {
                const udpPakcetLength = new DataView(chunk.slice(index, index + 2)).getUint16(0);
                controller.enqueue(new Uint8Array(chunk.slice(index + 2, index + 2 + udpPakcetLength)));
                index += 2 + udpPakcetLength;
            }
        }
    });
    transformStream.readable.pipeTo(new WritableStream({
        async write(chunk) {
            const resp = await fetch('https://cloudflare-dns.com/dns-query', {
                method: 'POST',
                headers: { 'content-type': 'application/dns-message' },
                body: chunk
            });
            const dnsQueryResult = await resp.arrayBuffer();
            const udpSizeBuffer = new Uint8Array([(dnsQueryResult.byteLength >> 8) & 0xff, dnsQueryResult.byteLength & 0xff]);
            if (webSocket.readyState === WS_READY_STATE_OPEN) {
                const blobParts = isVlessHeaderSent ? [udpSizeBuffer, dnsQueryResult] : [vlessResponseHeader, udpSizeBuffer, dnsQueryResult];
                webSocket.send(await new Blob(blobParts).arrayBuffer());
                isVlessHeaderSent = true;
            }
        }
    })).catch(() => {});
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
