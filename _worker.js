import { connect } from 'cloudflare:sockets';
if (!isValidUUID(userID)) {
	throw new Error('uuid is not valid');
}
export default {
    async fetch(request, env) {
        try {
            const userID = env.UUID || '';
            const proxyIP = env.PROXYIP || '';           
            return request.headers.get('Upgrade') === 'websocket'
                ? handleWebSocket(request, userID, proxyIP) 
                : handleNonWebSocketRequest(request, userID);
        } catch {}
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
                headers: { "Content-Type": "text/plain;charset=utf-8", "Alt-Svc": 'h3=":443"; ma=86400' }
            });        
        default:
            url.hostname = 'cn.bing.com';
            url.protocol = 'https:';
            return fetch(new Request(url, request));
    }
}
async function handleWebSocket(request, userID, proxyIP) {
    const [client, webSocket] = new WebSocketPair();
    webSocket.accept();
    const readableStream = createReadableWebSocketStream(webSocket, request.headers.get('sec-websocket-protocol') || '');
    let remoteSocket = { value: null }, udpStreamWrite = null, isDns = false;
    readableStream.pipeTo(new WritableStream({
        async write(chunk) {
            if (isDns && udpStreamWrite) return udpStreamWrite(chunk);
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
    })).catch(error => {});
    return new Response(null, { status: 101, webSocket: client });
}
async function handleQUICOutbound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, proxyIP) {
    const connectAndWrite = async (address, port) => {
        const quicSocket = connect({ hostname: address, port, protocol: 'quic' });
        remoteSocket.value = quicSocket;
        const writer = quicSocket.writable.getWriter();
        try { await writer.write(rawClientData); } finally { writer.releaseLock(); }
        return quicSocket;
    };
    const forwardAndHandleFallback = async (quicSocket) => {
        await forwardDataToWebSocket(quicSocket, webSocket, vlessResponseHeader);
        const fallbackSocket = await connectAndWrite(proxyIP || addressRemote, portRemote);
        fallbackSocket.closed.catch(() => {}).finally(() => closeWebSocketSafely(webSocket));
        await forwardDataToWebSocket(fallbackSocket, webSocket, vlessResponseHeader);
    };
    try {
        const quicSocket = await connectAndWrite(addressRemote, portRemote);
        await forwardAndHandleFallback(quicSocket);
    } catch (error) {
        closeWebSocketSafely(webSocket);
    }
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
        cancel() { isCancelled = true; closeWebSocketSafely(webSocket); }
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
    let addressValue, addressValueIndex;
    const addressLength = addressType === 2 ? view.getUint8(addressIndex + 1) : (addressType === 1 ? 4 : 16);
    addressValueIndex = addressIndex + (addressType === 2 ? 2 : 1);    
    if (addressType === 1) {
        addressValue = Array.from(new Uint8Array(buffer, addressValueIndex, 4)).join('.');
    } else if (addressType === 2) {
        addressValue = new TextDecoder().decode(new Uint8Array(buffer, addressValueIndex, addressLength));
    } else if (addressType === 3) {
        addressValue = Array.from(new Uint8Array(buffer, addressValueIndex, 16))
            .map(b => b.toString(16).padStart(2, '0'))
            .join(':');
    }    
    return { addressRemote: addressValue, portRemote, rawDataIndex: addressValueIndex + addressLength, vlessVersion: 0, isUDP };
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
    } catch { closeWebSocketSafely(webSocket); }
    if (!hasIncomingData && retry) retry();
}
function base64ToArrayBuffer(base64Str) {
    if (!base64Str) return { error: null };    
    try {
        const binaryString = atob(base64Str.replace(/-/g, '+').replace(/_/g, '/'));
        return { earlyData: new Uint8Array([...binaryString].map(char => char.charCodeAt(0))).buffer, error: null };
    } catch (error) { return { error }; }
}
function closeWebSocketSafely(socket) {
    if ([WebSocket.OPEN, WebSocket.CLOSING].includes(socket.readyState)) {
        try { socket.close(); } catch {}
    }
}
function isValidUUID(uuid) {
	const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
	return uuidRegex.test(uuid);
}
const byteToHex = [];
for (let i = 0; i < 256; ++i) {
	byteToHex.push((i + 256).toString(16).slice(1));
}
function unsafeStringify(arr, offset = 0) {
	return (byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + "-" + byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + "-" + byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + "-" + byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + "-" + byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]).toLowerCase();
}
function stringify(arr, offset = 0) {
	const uuid = unsafeStringify(arr, offset);
	if (!isValidUUID(uuid)) {
		throw TypeError("Stringified UUID is invalid");
	}
	return uuid;
}
async function handleUDPOutbound(webSocket, vlessResponseHeader, rawClientData) {
    let isHeaderSent = false;
    const dnsServers = ['https://dns.google/dns-query', 'https://cloudflare-dns.com/dns-query'];
    const dnsFetch = async (url, chunk) => {
        const startTime = performance.now();
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/dns-message' },
                body: chunk
            });
            const arrayBuffer = await response.arrayBuffer();
            return { url, arrayBuffer, duration: performance.now() - startTime };
        } catch (error) { return { url, error, duration: Infinity }; }
    };
    const transformStream = new TransformStream({
        async transform(chunk, controller) {
            let index = 0;
            while (index < chunk.byteLength) {
                const udpPacketLength = new DataView(chunk.slice(index, index + 2)).getUint16(0);
                const fetchPromises = dnsServers.map(url => dnsFetch(url, chunk.slice(index + 2, index + 2 + udpPacketLength)));
                const results = await Promise.all(fetchPromises);
                const bestResult = results.reduce((prev, curr) => curr.duration < prev.duration ? curr : prev);
                const dnsResult = bestResult.arrayBuffer;
                const udpSizeBuffer = new Uint8Array([(dnsResult.byteLength >> 8) & 0xff, dnsResult.byteLength & 0xff]);
                if (webSocket.readyState === WebSocket.OPEN) {
                    webSocket.send(new Uint8Array([...(!isHeaderSent ? vlessResponseHeader : []), ...udpSizeBuffer, ...new Uint8Array(dnsResult)]).buffer);
                    isHeaderSent = true;
                }
                index += 2 + udpPacketLength;
            }
        }
    });
    transformStream.readable.pipeTo(new WritableStream());
    const writer = transformStream.writable.getWriter();
    await writer.write(rawClientData);
}
function getVLESSConfig(userID, hostName) {
    return `
vless://${userID}\u0040${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
}
