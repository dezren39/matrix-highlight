import * as sdk from "matrix-js-sdk";
import {PORT_POP, PORT_TAB, FromContentMessage, FromPopupMessage, ToPopupMessage, ToContentMessage, RoomMembership} from "../common/messages";
import {createRoom, joinRoom, leaveRoom, inviteUser, sendHighlight, setHighlightVisibility, checkRoom} from "./actions";
import {fetchRequest} from "./fetch-request";
import {processRoom, processMember, processEvent} from "./events";

const LOCALSTORAGE_ID_KEY = "matrixId";
const LOCALSTORAGE_TOKEN_KEY = "matrixToken";

let client: sdk.MatrixClient | null = null;
sdk.request(fetchRequest);

const hookedTabs: Map<number, chrome.runtime.Port> = new Map();

async function broadcastUrl(url: string, event: ToContentMessage | ToContentMessage[]): Promise<void> {
    const tabs = await chrome.tabs.query({ url });
    const events = Array.isArray(event) ? event : [event];
    for (const event of events) {
        for (const tab of tabs) {
            if (!hookedTabs.has(tab.id!)) continue;
            hookedTabs.get(tab.id!)?.postMessage(event);
        }
    }
}

async function broadcastRoom(roomId: string, event: ToContentMessage | ToContentMessage[] | null): Promise<void> {
    const url = checkRoom(client!.getRoom(roomId)!);
    if (!url || !event) return;
    broadcastUrl(url, event);
}

async function emitRoom(client: sdk.MatrixClient, room: sdk.Room): Promise<void> {
    await broadcastRoom(room.roomId, processRoom(client, room));
}

async function emitEvent(event: sdk.MatrixEvent): Promise<void> {
    await broadcastRoom(event.getRoomId(), processEvent(event));
};

async function emitMember(roomId: string, oldMembership: RoomMembership | null, member: sdk.RoomMember): Promise<void>{
    await broadcastRoom(roomId, processMember(roomId, oldMembership, member));
}

async function setupClient(newClient: sdk.MatrixClient) {
    client = newClient;
    newClient.on("sync", state => {
        if (state !== "PREPARED") return;
        // During initial sync, we receive events from rooms. That's nice,
        // but if we also process the timelines of rooms we select, we end
        // up double-counting events. So instead, ignore events from initial
        // sync, and process them manually afterwards.
        newClient.on("Room", (room: sdk.Room) => {
            emitRoom(newClient, room);
        });
        newClient.on("Room.myMembership", (room: sdk.Room, membership: string) => {
            broadcastRoom(room.roomId, {
                type: "room-membership",
                roomId: room.roomId,
                membership: membership as RoomMembership
            });
        });
        newClient.on("event", (event: sdk.MatrixEvent) => {
            emitEvent(event);
        });
        newClient.on("RoomMember.membership", (event: sdk.MatrixEvent, member: sdk.RoomMember, oldMembership: RoomMembership | null) => {
            emitMember(event.getRoomId(), oldMembership, member);
        });
        for (const room of newClient.getRooms()) {
            emitRoom(newClient, room);
        }
    });
    await newClient.startClient({initialSyncLimit: 100});
};

chrome.runtime.onInstalled.addListener(async () => {
    chrome.contextMenus.create({
        title: "Highlight using Matrix",
        contexts: ["page"],
        id: "com.danilafe.highlight_context_menu",
    });

    const credentials = await chrome.storage.sync.get([LOCALSTORAGE_ID_KEY, LOCALSTORAGE_TOKEN_KEY]);
    const id: string | undefined = credentials[LOCALSTORAGE_ID_KEY];
    const token: string | undefined = credentials[LOCALSTORAGE_TOKEN_KEY];
    if (id && token) {
        const server = id.substring(id.indexOf(":") + 1);
        setupClient(sdk.createClient({
            baseUrl: `https://${server}`,
            userId: id,
            accessToken: token
        }));
    }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (!tab?.id) return;
    await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [ "content.js" ]
    });
});

function sendToPopup(port: chrome.runtime.Port, message: ToPopupMessage) {
    port.postMessage(message);
}

function setupPopupPort(port: chrome.runtime.Port) {
    if (client) {
        const username = client.getUserId();
        const homeserver = client.getHomeserverUrl();
        const name = client.getUser(username).displayName;
        sendToPopup(port, { type: "login-successful", username, homeserver, name });
    } else {
        sendToPopup(port, { type: "login-required" });
    }
    port.onMessage.addListener(async (message: FromPopupMessage) => {
        if (message.type === "attempt-login") {
            const {username, password, homeserver} = message;
            const newClient = sdk.createClient({ baseUrl: `https://${homeserver}` });
            const result = await newClient.loginWithPassword(username, password);
            if (result.errcode) {
                sendToPopup(port, { type: "login-failed" });
                return;
            }

            chrome.storage.sync.set({
                [LOCALSTORAGE_ID_KEY]: result.user_id,
                [LOCALSTORAGE_TOKEN_KEY]: result.access_token
            });
            await setupClient(newClient);
            const name = newClient.getUser(newClient.getUserId()).displayName;
            sendToPopup(port, { type: "login-successful", username, homeserver, name });
        }
    });
}

function setupTabPort(port: chrome.runtime.Port) {
    const tab = port.sender?.tab;
    if (!tab?.id) return;
    console.log("Got new connection!");
    hookedTabs.set(tab.id, port);
    // Catch new page with existing pages
    if (client) {
        for (const room of client.getRooms()) {
            const url = checkRoom(room);
            if (!url || url !== tab.url) continue;
            const roomEvents = processRoom(client, room);
            for (const event of roomEvents) {
                console.log("Sending event", event);
                port.postMessage(event);
            }
        }
    }
    port.onMessage.addListener((message: FromContentMessage) => {
        if (message.type === "create-room") {
            createRoom(client!, message.name, message.url);
        } else if (message.type === "join-room") {
            joinRoom(client!, message.roomId);
        } else if (message.type === "leave-room") {
            leaveRoom(client!, message.roomId);
        }  else if (message.type === "invite-user") {
            inviteUser(client!, message.roomId, message.userId);
        } else if (message.type === "send-highlight") {
            sendHighlight(client!, message.roomId, message.highlight, message.txnId);
        } else if (message.type === "set-highlight-visibility") {
            setHighlightVisibility(client!, message.roomId, message.highlightId, message.visibility);
        }
    });
}

chrome.runtime.onConnect.addListener(port => {
    if (port.name === PORT_POP) setupPopupPort(port);
    else if (port.name === PORT_TAB) setupTabPort(port);
});
