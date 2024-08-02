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

            const protocol = request.headers.get('X-Protocol');
            if (protocol === 'grpc') {
                return handleGrpcRequest(request, userID, proxyIP);
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
                handleTCPOutbound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, proxyIP);
            }
        },
    }));
    return new Response(null, { status: 101, webSocket: client });
}

async function handleGrpcRequest(request, userID, proxyIP) {
    const [client, stream] = new DuplexStream();
    const readableStream = createReadableGrpcStream(stream);
    const vlessHeader = new Uint8Array([0, 0]);

    let remoteSocket = { value: null };
    readableStream.pipeTo(new WritableStream({
        async write(chunk) {
            if (remoteSocket.value) {
                const writer = remoteSocket.value.writable.getWriter();
                await writer.write(chunk);
                writer.releaseLock();
                return;
            }
            const { hasError, addressRemote, portRemote, rawDataIndex, vlessVersion, isUDP } = processVlessHeader(chunk, userID);
            if (hasError) return;
            const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
            const rawClientData = chunk.slice(rawDataIndex);
            handleTCPOutbound(remoteSocket, addressRemote, portRemote, rawClientData, stream, vlessResponseHeader, proxyIP);
        },
    }));

    return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/grpc' } });
}

async function handleTCPOutbound(remoteSocket, addressRemote, portRemote, rawClientData, stream, vlessResponseHeader, proxyIP) {
    const connectAndWrite = async (address, port) => {
        const tcpSocket = connect({ hostname: address, port });
        remoteSocket.value = tcpSocket;
        const writer = tcpSocket.writable.getWriter();
        await writer.write(rawClientData);
        writer.releaseLock();
        return tcpSocket;
    };
    const retry = async () => {
        const tcpSocket = await connectAndWrite(proxyIP || addressRemote, portRemote);
        tcpSocket.closed.catch(() => {}).finally(() => closeStreamSafely(stream));
        forwardDataToStream(tcpSocket, stream, vlessResponseHeader, null);
    };
    const tcpSocket = await connectAndWrite(addressRemote, portRemote);
    forwardDataToStream(tcpSocket, stream, vlessResponseHeader, retry);
}

function createReadableGrpcStream(stream) {
    let isCancelled = false;
    return new ReadableStream({
        start(controller) {
            const handleData = event => {
                if (!isCancelled) {
                    controller.enqueue(event.data);
                }
            };
            stream.addEventListener('data', handleData);
            stream.addEventListener('end', () => controller.close());
            stream.addEventListener('error', err => controller.error(err));
        },
        cancel() {
            isCancelled = true;
            closeStreamSafely(stream);
        }
    });
}

function forwardDataToStream(remoteSocket, stream, vlessResponseHeader, retry) {
    let hasIncomingData = false;
    try {
        await remoteSocket.readable.pipeTo(new WritableStream({
            async write(chunk) {
                hasIncomingData = true;
                if (stream.readyState !== 'open') throw new Error('Stream is not open');
                
                if (vlessResponseHeader) {
                    const combinedData = new Uint8Array([...vlessResponseHeader, ...new Uint8Array(chunk)]);
                    stream.write(combinedData.buffer);
                    vlessResponseHeader = null;
                } else {
                    stream.write(chunk);
                }
            }
        }));
    } catch {
        closeStreamSafely(stream);
    }
    if (!hasIncomingData && retry) retry();
}

function closeStreamSafely(stream) {
    try {
        if (stream.readyState === 'open' || stream.readyState === 'closing') {
            stream.end();
        }
    } catch {}
}

const byteToHex = Array.from({ length: 256 }, (_, i) => (i + 256).toString(16).slice(1));

function stringify(arr) {
    return Array.from(arr.slice(0, 16), byte => byteToHex[byte]).join('')
        .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')
        .toLowerCase();
}

async function handleUDPOutbound(stream, vlessResponseHeader) {
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
            if (stream.readyState === 'open') {
                const combinedData = new Uint8Array([...(!isHeaderSent ? vlessResponseHeader : []), ...udpSizeBuffer, ...new Uint8Array(dnsResult)]);
                stream.write(combinedData.buffer);
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
