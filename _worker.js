import { connect } from 'cloudflare:sockets';
export default {
    async fetch(request, env) {
        try {
            const userID = env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4';
            const proxyIP = env.PROXYIP || '';
            return request.headers.get('Upgrade') === 'websocket'
                ? handleWebSocket(request, userID, proxyIP) : handleNonWebSocketRequest(request, userID);
        } catch (err) {
            return new Response(err.toString());
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
                headers: {
                    "Content-Type": "text/plain;charset=utf-8",
                    "Alt-Svc": 'h3=":443"; ma=86400',
                    "Link": '<//example.com>; rel=dns-prefetch, <//anotherdomain.com>; rel=dns-prefetch'
                }
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
            isDns ? await handleUDPOutbound(webSocket, vlessResponseHeader, rawClientData)
                : handleQUICOutbound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, proxyIP);
        }
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
    let quicSocket;
    try {
        quicSocket = await connectAndWrite(addressRemote, portRemote);
        await forwardDataToWebSocket(quicSocket, webSocket, vlessResponseHeader, async () => {
            const fallbackSocket = await connectAndWrite(proxyIP || addressRemote, portRemote);
            fallbackSocket.closed.catch(() => {}).finally(() => closeWebSocketSafely(webSocket));
            forwardDataToWebSocket(fallbackSocket, webSocket, vlessResponseHeader);
        });
    } catch (error) {
        console.error('Error in handleQUICOutbound:', error);
    } finally {
        if (quicSocket) {
            quicSocket.closed.catch(() => {}).finally(() => closeWebSocketSafely(webSocket));
        } else {
            closeWebSocketSafely(webSocket);
        }
    }
}
function createReadableWebSocketStream(webSocket, earlyDataHeader) {
    let isCancelled = false;
    return new ReadableStream({
        start(controller) {
            webSocket.addEventListener('message', event => !isCancelled && controller.enqueue(new Uint8Array(event.data)));
            webSocket.addEventListener('close', () => controller.close());
            webSocket.addEventListener('error', err => controller.error(err));
            const { earlyData, error } = base64ToUint8Array(earlyDataHeader);
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
    let addressValue, addressValueIndex;
    const addressLength = addressType === 2 ? view.getUint8(addressIndex + 1) : (addressType === 1 ? 4 : 16);
    addressValueIndex = addressIndex + (addressType === 2 ? 2 : 1);
    if (addressType === 1) {
        addressValue = `${view.getUint8(addressValueIndex)}.${view.getUint8(addressValueIndex + 1)}.${view.getUint8(addressValueIndex + 2)}.${view.getUint8(addressValueIndex + 3)}`;
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
                const response = vlessResponseHeader ? new Uint8Array([...vlessResponseHeader, ...new Uint8Array(chunk)]) : new Uint8Array(chunk);
                webSocket.send(response.buffer);
                vlessResponseHeader = null;
            }
        }));
    } catch (error) {
    } finally {
        if (!hasIncomingData && retry) {
            retry();
        } else {
            closeWebSocketSafely(webSocket);
        }
    }
}

function base64ToUint8Array(base64Str) {
    if (!base64Str) return { error: null };
    try {
        const binaryString = atob(base64Str.replace(/-/g, '+').replace(/_/g, '/'));
        return { earlyData: new Uint8Array([...binaryString].map(char => char.charCodeAt(0))), error: null };
    } catch (error) {
        return { error };
    }
}
function closeWebSocketSafely(socket) {
    if ([WebSocket.OPEN, WebSocket.CLOSING].includes(socket.readyState)) {
        try { socket.close(); } catch (error) {}
    }
}
const byteToHex = Array.from({ length: 256 }, (_, i) => (i + 256).toString(16).slice(1));
function stringify(arr) {
    return Array.from(arr.slice(0, 16), byte => byteToHex[byte]).join('').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5').toLowerCase();
}
async function handleUDPOutbound(webSocket, vlessResponseHeader, rawClientData) {
    let isHeaderSent = false;
    const dnsFetch = async (chunk) => {
        const response = await fetch('https://cloudflare-dns.com/dns-query', {
            method: 'POST',
            headers: { 'content-type': 'application/dns-message' },
            body: chunk
        });
        return response.arrayBuffer();
    };
    const transformStream = new TransformStream({
        async transform(chunk, controller) {
            let index = 0;
            while (index < chunk.byteLength) {
                const udpPacketLength = (chunk[index] << 8) | chunk[index + 1];
                const dnsResult = await dnsFetch(chunk.slice(index + 2, index + 2 + udpPacketLength));
                const udpSizeBuffer = new Uint8Array([(dnsResult.byteLength >> 8) & 0xff, dnsResult.byteLength & 0xff]);
                if (webSocket.readyState === WebSocket.OPEN) {
                    const response = new Uint8Array([...(!isHeaderSent ? vlessResponseHeader : []), ...udpSizeBuffer, ...new Uint8Array(dnsResult)]);
                    webSocket.send(response.buffer);
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
vless://${userID}\u0040${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&alpn=h3&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}
`;
}
