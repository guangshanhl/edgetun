import { connect } from 'cloudflare:sockets';
let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let proxyIP = '';
if (!isValidUUID(userID)) {
	throw new Error('uuid is not valid');
}
export default {
	async fetch(request, env, ctx) {
		try {
			userID = env.UUID || userID;
			proxyIP = env.PROXYIP || proxyIP;
			const upgradeHeader = request.headers.get('Upgrade');
			if (!upgradeHeader || upgradeHeader !== 'websocket') {
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
						return new Response('Not found', { status: 404 });
				}
			} else {
				return await vlessOverWSHandler(request);
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
	let address = '';
	const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
	const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader);
	let remoteSocketWapper = {
		value: null,
	};
	let udpStreamWrite = null;
	let isDns = false;
	readableWebSocketStream.pipeTo(new WritableStream({
		async write(chunk, controller) {
			if (isDns && udpStreamWrite) {
				return udpStreamWrite(chunk);
			}
			if (remoteSocketWapper.value) {
				const writer = remoteSocketWapper.value.writable.getWriter()
				await writer.write(chunk);
				writer.releaseLock();
				return;
			}
			const {
				hasError,
				message,
				portRemote = 443,
				addressRemote = '',
				rawDataIndex,
				vlessVersion = new Uint8Array([0, 0]),
				isUDP,
			} = processVlessHeader(chunk, userID);
			address = addressRemote;
			if (hasError) {
				return;
			}
			if (isUDP) {
				if (portRemote === 53) {
					isDns = true;
				} else {
					return;
				}
			}
			const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
			const rawClientData = chunk.slice(rawDataIndex);
			if (isDns) {
				const { write } = await handleUDPOutBound(webSocket, vlessResponseHeader);
				udpStreamWrite = write;
				udpStreamWrite(rawClientData);
				return;
			}
			handleTCPOutBound(remoteSocketWapper, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader,);
		},
	})).catch((err) => {});
	return new Response(null, {
		status: 101,
		webSocket: client,
	});
}
async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader,) {
	async function connectAndWrite(address, port) {
		const tcpSocket = connect({
			hostname: address,
			port: port,
		});
		remoteSocket.value = tcpSocket;
		const writer = tcpSocket.writable.getWriter();
		await writer.write(rawClientData);
		writer.releaseLock();
		return tcpSocket;
	}
	async function retry() {
		const tcpSocket = await connectAndWrite(proxyIP || addressRemote, portRemote)
		tcpSocket.closed.catch(error => {
		}).finally(() => {
			safeCloseWebSocket(webSocket);
		})
		remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, null);
	}
	const tcpSocket = await connectAndWrite(addressRemote, portRemote);
	remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retry);
}
function makeReadableWebSocketStream(webSocket, earlyDataHeader) {
    let readableStreamCancel = false;
    return new ReadableStream({
        start(controller) {
            webSocket.addEventListener('message', event => {
                if (readableStreamCancel) return;
                controller.enqueue(event.data);
            });
            webSocket.addEventListener('close', () => {
                safeCloseWebSocket(webSocket);
                if (readableStreamCancel) return;
                controller.close();
            });
            webSocket.addEventListener('error', err => controller.error(err));
            const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
            if (error) {
                controller.error(error);
            } else if (earlyData) {
                controller.enqueue(earlyData);
            }
        },
        pull() {},
        cancel() {
            if (readableStreamCancel) return;
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
	const command = new Uint8Array(vlessBuffer.slice(18 + optLength, 19 + optLength))[0];
	if (![1, 2].includes(command)) return { hasError: true };
	const isUDP = (command === 2);
	const portIndex = 18 + optLength + 1;
	const portRemote = new DataView(vlessBuffer.slice(portIndex, portIndex + 2)).getUint16(0);
	let addressIndex = portIndex + 2;
	const addressType = new Uint8Array(vlessBuffer.slice(addressIndex, addressIndex + 1))[0];
	let addressValue = '';
	let addressLength = 0;
	switch (addressType) {
		case 1:
			addressLength = 4;
			addressValue = new Uint8Array(vlessBuffer.slice(addressIndex + 1, addressIndex + 5)).join('.');
			break;
		case 2:
			addressLength = new Uint8Array(vlessBuffer.slice(addressIndex + 1, addressIndex + 2))[0];
			addressValue = new TextDecoder().decode(vlessBuffer.slice(addressIndex + 2, addressIndex + 2 + addressLength));
			break;
		case 3:
			addressLength = 16;
			const dataView = new DataView(vlessBuffer.slice(addressIndex + 1, addressIndex + 17));
			const ipv6 = [];
			for (let i = 0; i < 8; i++) ipv6.push(dataView.getUint16(i * 2).toString(16));
			addressValue = ipv6.join(':');
			break;
		default:
			return { hasError: true };
	}
	if (!addressValue) return { hasError: true };
	return {
		hasError: false,
		addressRemote: addressValue,
		addressType,
		portRemote,
		rawDataIndex: addressIndex + 1 + addressLength,
		vlessVersion: version,
		isUDP,
	};
}
async function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, retry) {
    let vlessHeader = vlessResponseHeader;
    let hasIncomingData = false;
    await remoteSocket.readable.pipeTo(new WritableStream({
        async write(chunk) {
            hasIncomingData = true;
            if (webSocket.readyState === WebSocket.OPEN) {
                if (vlessHeader) {
                    webSocket.send(await new Blob([vlessHeader, chunk]).arrayBuffer());
                    vlessHeader = null;
                } else {
                    webSocket.send(chunk);
                }
            }
        }
    })).catch(() => safeCloseWebSocket(webSocket));
    if (!hasIncomingData && retry) retry();
}
function base64ToArrayBuffer(base64Str) {
    if (!base64Str) return { error: null };
    try {
        base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
        const decodedStr = atob(base64Str);
        return { earlyData: Uint8Array.from(decodedStr, c => c.charCodeAt(0)).buffer, error: null };
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
        if ([WebSocket.OPEN, WebSocket.CLOSING].includes(socket.readyState)) {
            socket.close();
        }
    } catch (error) {}
}
const byteToHex = Array.from({ length: 256 }, (_, i) => (i + 256).toString(16).slice(1));
function unsafeStringify(arr, offset = 0) {
    return `${byteToHex[arr[offset + 0]]}${byteToHex[arr[offset + 1]]}${byteToHex[arr[offset + 2]]}${byteToHex[arr[offset + 3]]}-${byteToHex[arr[offset + 4]]}${byteToHex[arr[offset + 5]]}-${byteToHex[arr[offset + 6]]}${byteToHex[arr[offset + 7]]}-${byteToHex[arr[offset + 8]]}${byteToHex[arr[offset + 9]]}-${byteToHex[arr[offset + 10]]}${byteToHex[arr[offset + 11]]}${byteToHex[arr[offset + 12]]}${byteToHex[arr[offset + 13]]}${byteToHex[arr[offset + 14]]}${byteToHex[arr[offset + 15]]}`.toLowerCase();
}
function stringify(arr, offset = 0) {
    const uuid = unsafeStringify(arr, offset);
    if (!isValidUUID(uuid)) {
        throw TypeError("Stringified UUID is invalid");
    }
    return uuid;
}
async function handleUDPOutBound(webSocket, vlessResponseHeader) {
    let isVlessHeaderSent = false;
    const transformStream = new TransformStream({
        start() {},
        transform(chunk, controller) {
            for (let index = 0; index < chunk.byteLength;) {
                const lengthBuffer = chunk.slice(index, index + 2);
                const udpPacketLength = new DataView(lengthBuffer).getUint16(0);
                const udpData = new Uint8Array(chunk.slice(index + 2, index + 2 + udpPacketLength));
                index += 2 + udpPacketLength;
                controller.enqueue(udpData);
            }
        }
    });
    transformStream.readable.pipeTo(new WritableStream({
        async write(chunk) {
            const responses = await Promise.all([
                fetch('https://cloudflare-dns.com/dns-query', { method: 'POST', headers: { 'content-type': 'application/dns-message' }, body: chunk }).then(resp => resp.arrayBuffer()),
                fetch('https://dns.google/resolve', { method: 'POST', headers: { 'content-type': 'application/dns-message' }, body: chunk }).then(resp => resp.arrayBuffer())
            ]);
            const fastestResponse = responses.reduce((a, b) => (a.byteLength < b.byteLength ? a : b));
            const udpSizeBuffer = new Uint8Array([(fastestResponse.byteLength >> 8) & 0xff, fastestResponse.byteLength & 0xff]);
            if (webSocket.readyState === WebSocket.OPEN) {
                const blobData = isVlessHeaderSent ? [udpSizeBuffer, fastestResponse] : [vlessResponseHeader, udpSizeBuffer, fastestResponse];
                webSocket.send(await new Blob(blobData).arrayBuffer());
                isVlessHeaderSent = true;
            }
        }
    })).catch(() => {});
    const writer = transformStream.writable.getWriter();
    return { write: chunk => writer.write(chunk) };
}
function getVLESSConfig(userID, hostName) {
	const vlessMain = `vless://${userID}\u0040${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`
	return `
################################################################
v2ray
---------------------------------------------------------------
${vlessMain}
---------------------------------------------------------------
################################################################
`;
}
