import { connect } from 'cloudflare:sockets';

let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let proxyIP = '';

if (!isValidUUID(userID)) {
	throw new Error('uuid is not valid');
}

export default {
	async fetch(request, env, ctx) {
		try {
			const userID = env.UUID || userID;
			const proxyIP = env.PROXYIP || proxyIP;
			const upgradeHeader = request.headers.get('Upgrade');
			if (upgradeHeader === 'websocket') {
				return await vlessOverWSHandler(request);
			}
			const url = new URL(request.url);
			switch (url.pathname) {
				case '/':
					return new Response(JSON.stringify(request.cf, null, 4), { status: 200 });
				case `/${userID}`: {
					const vlessConfig = getVLESSConfig(userID, request.headers.get('Host'));
					return new Response(vlessConfig, {
						status: 200,
						headers: { "Content-Type": "text/plain;charset=utf-8" }
					});
				}
				default:
					url.hostname = 'www.bing.com';
					url.protocol = 'https:';
					const modifiedRequest = new Request(url, request);
					return await fetch(modifiedRequest);
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
	const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
	const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader);
	let remoteSocketWrapper = { value: null };
	let udpStreamWrite = null;
	let isDns = false;
	readableWebSocketStream.pipeTo(new WritableStream({
		async write(chunk, controller) {
			if (isDns && udpStreamWrite) {
				return udpStreamWrite(chunk);
			}
			if (remoteSocketWrapper.value) {
				const writer = remoteSocketWrapper.value.writable.getWriter();
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
			if (hasError) throw new Error(message);
			if (isUDP) {
				if (portRemote === 53) {
					isDns = true;
				} else {
					throw new Error('UDP proxy only enabled for DNS (port 53)');
				}
			}
			const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
			const rawClientData = chunk.slice(rawDataIndex);

			if (isDns) {
				const { write } = await handleUDPOutBound(webSocket, vlessResponseHeader);
				udpStreamWrite = write;
				udpStreamWrite(rawClientData);
			} else {
				handleTCPOutBound(remoteSocketWrapper, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader);
			}
		},
		close() {},
		abort(reason) {},
	})).catch((err) => console.error('Stream error:', err));
	return new Response(null, { status: 101, webSocket: client });
}

async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader) {
	async function connectAndWrite(address, port) {
		const tcpSocket = connect({ hostname: address, port: port });
		remoteSocket.value = tcpSocket;
		const writer = tcpSocket.writable.getWriter();
		await writer.write(rawClientData);
		writer.releaseLock();
		return tcpSocket;
	}
	async function retry() {
		const tcpSocket = await connectAndWrite(proxyIP || addressRemote, portRemote);
		tcpSocket.closed.catch(() => {}).finally(() => {
			safeCloseWebSocket(webSocket);
		});
		remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, null);
	}
	const tcpSocket = await connectAndWrite(addressRemote, portRemote);
	remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retry);
}

function makeReadableWebSocketStream(webSocketServer, earlyDataHeader) {
	let readableStreamCancel = false;
	const stream = new ReadableStream({
		start(controller) {
			const handleMessage = (event) => {
				if (!readableStreamCancel) {
					controller.enqueue(event.data);
				}
			};			
			const handleClose = () => {
				safeCloseWebSocket(webSocketServer);
				if (!readableStreamCancel) {
					controller.close();
				}
			};
			const handleError = (err) => controller.error(err);
			webSocketServer.addEventListener('message', handleMessage);
			webSocketServer.addEventListener('close', handleClose);
			webSocketServer.addEventListener('error', handleError);
			const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
			if (error) {
				controller.error(error);
			} else if (earlyData) {
				controller.enqueue(earlyData);
			}
		},
		cancel() {
			if (!readableStreamCancel) {
				readableStreamCancel = true;
				safeCloseWebSocket(webSocketServer);
			}
		}
	});	
	return stream;
}

function processVlessHeader(vlessBuffer, userID) {
	if (vlessBuffer.byteLength < 24) {
		return { hasError: true };
	}
	const version = new Uint8Array(vlessBuffer.slice(0, 1));
	const userIdMatch = stringify(new Uint8Array(vlessBuffer.slice(1, 17))) === userID;
	if (!userIdMatch) {
		return { hasError: true };
	}
	const optLength = vlessBuffer[17];
	const command = vlessBuffer[18 + optLength];
	const isUDP = command === 2;
	if (![1, 2].includes(command)) {
		return { hasError: true };
	}
	const portIndex = 18 + optLength + 1;
	const portRemote = new DataView(vlessBuffer.slice(portIndex, portIndex + 2)).getUint16(0);
	const addressIndex = portIndex + 2;
	const addressType = vlessBuffer[addressIndex];
	let addressLength = 0;
	let addressValue = '';
	switch (addressType) {
		case 1:
			addressLength = 4;
			addressValue = Array.from(vlessBuffer.slice(addressIndex + 1, addressIndex + 1 + addressLength)).join('.');
			break;
		case 2:
			addressLength = vlessBuffer[addressIndex + 1];
			addressValue = new TextDecoder().decode(vlessBuffer.slice(addressIndex + 2, addressIndex + 2 + addressLength));
			break;
		case 3:
			addressLength = 16;
			const ipv6 = Array.from({ length: 8 }, (_, i) => new DataView(vlessBuffer.slice(addressIndex + 1, addressIndex + 1 + addressLength)).getUint16(i * 2).toString(16)).join(':');
			addressValue = ipv6;
			break;
		default:
			return { hasError: true };
	}
	if (!addressValue) {
		return { hasError: true };
	}
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
	let hasIncomingData = false;
	let vlessHeader = vlessResponseHeader;
	await remoteSocket.readable.pipeTo(
		new WritableStream({
			async write(chunk, controller) {
				hasIncomingData = true;
				if (webSocket.readyState !== WS_READY_STATE_OPEN) {
					return controller.error('webSocket.readyState is not open, maybe closed');
				}
				if (vlessHeader) {
					webSocket.send(await new Blob([vlessHeader, chunk]).arrayBuffer());
					vlessHeader = null;
				} else {
					webSocket.send(chunk);
				}
			},
		})
	).catch(() => safeCloseWebSocket(webSocket));
	if (!hasIncomingData && retry) {
		retry();
	}
}

function base64ToArrayBuffer(base64Str) {
	if (!base64Str) {
		return { error: null };
	}
	try {
		const decodedStr = atob(base64Str.replace(/-/g, '+').replace(/_/g, '/'));
		const arrayBuffer = Uint8Array.from(decodedStr, char => char.charCodeAt(0)).buffer;
		return { earlyData: arrayBuffer, error: null };
	} catch (error) {
		return { error };
	}
}

function isValidUUID(uuid) {
	const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
	return uuidRegex.test(uuid);
}
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;

function safeCloseWebSocket(socket) {
	try {
		if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
			socket.close();
		}
	} catch (error) {
	}
}

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

async function handleUDPOutBound(webSocket, vlessResponseHeader) {
	let isVlessHeaderSent = false;
	const transformStream = new TransformStream({
		transform(chunk, controller) {
			let index = 0;
			while (index < chunk.byteLength) {
				const udpPacketLength = new DataView(chunk.slice(index, index + 2)).getUint16(0);
				const udpData = new Uint8Array(chunk.slice(index + 2, index + 2 + udpPacketLength));
				controller.enqueue(udpData);
				index += 2 + udpPacketLength;
			}
		}
	});
	transformStream.readable.pipeTo(new WritableStream({
		async write(chunk) {
			const response = await fetch('https://cloudflare-dns.com/dns-query', {
				method: 'POST',
				headers: { 'Content-Type': 'application/dns-message' },
				body: chunk,
			});
			const dnsQueryResult = await response.arrayBuffer();
			const udpSizeBuffer = new Uint8Array([(dnsQueryResult.byteLength >> 8) & 0xff, dnsQueryResult.byteLength & 0xff]);
			if (webSocket.readyState === WS_READY_STATE_OPEN) {
				const dataToSend = isVlessHeaderSent
					? [udpSizeBuffer, dnsQueryResult]
					: [vlessResponseHeader, udpSizeBuffer, dnsQueryResult];
				
				webSocket.send(await new Blob(dataToSend).arrayBuffer());
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
