import { DurableObject } from "cloudflare:workers";

export class MyDurableObject extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.state = state;
    this.env = env;
    this.waitingQueue = [];
    this.rooms = new Map();
  }

	  async fetch(request) {
		if (request.headers.get("Upgrade") !== "websocket") {
		  return new Response("Expected WebSocket", { status: 400 });
		}

		const url = new URL(request.url);
		const params = url.searchParams;
		const name = params.get("name");
		const age = params.get("age");
		const gender = params.get("gender");
		const lookingFor = params.get("lookingFor");
		const sessionId = crypto.randomUUID();

		const [client, server] = new WebSocketPair();
		this.handleSession(server, { sessionId, name, age, gender, lookingFor });

		return new Response(null, {
		  status: 101,
		  webSocket: client
		});
	  }

	findPartner(sessionId) {
	  for (const room of this.rooms.values()) {
		if (room.user1.sessionId === sessionId) return room.user2;
		if (room.user2.sessionId === sessionId) return room.user1;
	  }
	  return null;
	}

	async handleSession(ws, user) {
		try {
			ws.accept();
			user.ws = ws;
			this.waitingQueue.push(user);
			this.tryMatch();

			ws.addEventListener("message", (msg) => {
				let data;
				try {
				  data = JSON.parse(msg.data);
				} catch {
				  return; // Bỏ qua nếu không phải JSON
				}
				if (data.event === "chat" && data.roomId && data.message) {
					for (const [roomId, room] of this.rooms.entries()) {
					if (
					  (room.user1.sessionId === user.sessionId ||
						room.user2.sessionId === user.sessionId) &&
					  roomId === data.roomId
					) {
					  const otherUser =
						room.user1.sessionId === user.sessionId
						  ? room.user2
						  : room.user1;
					  if (otherUser.ws.readyState === WebSocket.OPEN) {
						otherUser.ws.send(
						  JSON.stringify({
							event: "chat",
							from: "",
							message: data.message,
						  })
						);
					  }
					  break;
					}
					}
				}
			});

			ws.addEventListener("close", (event) => {
				console.log(`WebSocket closed: code=${event.code}, reason=${event.reason}`);
				const partner = this.findPartner(user.sessionId);
				if (partner.ws.readyState === WebSocket.OPEN) {
					partner.ws.send(JSON.stringify({
						event: "partner_left",
						message: "Người kia đã thoát khỏi cuộc trò chuyện"
					}));
					console.log("Sent partner_left to partner");
				} else {
					console.warn("Partner WebSocket is not open");
				}
				this.removeUser(user.sessionId);
			});
		} catch (e) {
			  console.error("Error in handleSession:", e);
			  ws.close(1011, "Internal error");
		}
	}

	removeUser(sessionId) {
	  this.waitingQueue = this.waitingQueue.filter(u => u.sessionId !== sessionId);
	  for (const [roomId, room] of this.rooms.entries()) {
		if (room.user1.sessionId === sessionId || room.user2.sessionId === sessionId) {
		  this.rooms.delete(roomId);
		  console.log(`Room ${roomId} deleted because user ${sessionId} left`);
		  break; // Nếu mỗi user chỉ có 1 phòng
		}
	  }
	}

  tryMatch() {
    for (let i = 0; i < this.waitingQueue.length; i++) {
      for (let j = i + 1; j < this.waitingQueue.length; j++) {
        const u1 = this.waitingQueue[i];
        const u2 = this.waitingQueue[j];
        if (this.canMatch(u1, u2)) {
          this.createRoom(u1, u2);
          // Loại bỏ 2 user đã ghép
          this.waitingQueue.splice(j, 1);
          this.waitingQueue.splice(i, 1);
          i--;
          break;
        }
      }
    }
  }

  canMatch(u1, u2) {
    if (
      (u1.lookingFor === u2.gender) &&
      (u2.lookingFor === u1.gender)
    ) {
      return true;
    }
    if (this.waitingQueue.length > 80) return true;
    return false;
  }

  createRoom(u1, u2) {
    const roomId = crypto.randomUUID();
    this.rooms.set(roomId, { user1: u1, user2: u2 });

    if (u1.ws.readyState === WebSocket.OPEN) {
      u1.ws.send(JSON.stringify({
        event: "matched",
        partner: { name: u2.name, gender: u2.gender },
        roomId
      }));
    }
    if (u2.ws.readyState === WebSocket.OPEN) {
      u2.ws.send(JSON.stringify({
        event: "matched",
        partner: { name: u1.name, gender: u1.gender },
        roomId
      }));
    }
  }
}

// Export Durable Object đúng tên binding trong wrangler.toml
export default {
  DurableObjects: {
    MY_CHAT_ROOM: MyDurableObject
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/chat") {
      const id = env.MY_CHAT_ROOM.idFromName("default");
      const obj = env.MY_CHAT_ROOM.get(id);
      return obj.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  }
};
