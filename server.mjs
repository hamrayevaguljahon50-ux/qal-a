import { createServer } from "node:http";
import { randomBytes, randomInt } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const startingGold = 2000;
const rooms = new Map();
const unitSettings = {
  swordsman: { cost: 25, hp: 100, damage: 20, range: 28, speed: 33, interval: 0.8 },
  archer: { cost: 40, hp: 65, damage: 17, range: 165, speed: 25, interval: 1.15 },
  knight: { cost: 65, hp: 190, damage: 38, range: 34, speed: 21, interval: 1.05 },
  mage: { cost: 70, hp: 80, damage: 30, range: 155, speed: 22, interval: 1.2 },
  pistol: { cost: 55, hp: 75, damage: 24, range: 125, speed: 27, interval: 0.9 },
  cannon: { cost: 100, hp: 145, damage: 52, range: 190, speed: 12, interval: 2.2, splashRadius: 55 },
  spearman: { cost: 40, hp: 90, damage: 18, range: 44, speed: 39, interval: 0.7 },
  laser: { cost: 150, hp: 90, damage: 45, range: 230, speed: 20, interval: 0.9 }
};
const towerCost = 50;
const unitKillRewards = { swordsman: 20, archer: 20, knight: 20, mage: 100, pistol: 120, cannon: 500, spearman: 400, laser: 10000 };
const towerSettings = { damage: 22, range: 220, interval: 1.4, limit: 3 };
const castleUpgrade = { cost: 100, hp: 250, initialLimit: 3, unlockPerThree: 1000 };
const castleHeal = { cost: 40, hp: 200 };
const castleWidthScale = upgrades => 1.6 * (1 + Math.min(upgrades * 0.08, 1.2));
const jsonHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function sendJson(response, status, value) {
  response.writeHead(status, jsonHeaders);
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 4096) throw new Error("So‘rov hajmi juda katta.");
  }
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw new Error("JSON so‘rovi noto‘g‘ri.");
  }
}

function normalizedPlayerName(value, playerNumber) {
  if (value === undefined || value === null || value === "") return `O‘yinchi ${playerNumber}`;
  if (typeof value !== "string") throw new Error("O‘yinchi ismi matn bo‘lishi kerak.");
  const name = value.trim();
  if (name.length > 20) throw new Error("O‘yinchi ismi 20 ta belgidan oshmasin.");
  return name || `O‘yinchi ${playerNumber}`;
}

function createRoom(playerName, requestedCode) {
  if (rooms.size >= 1000) throw new Error("Hozir xonalar soni limiti to‘ldi.");
  let code = requestedCode;
  if (code === undefined || code === null || code === "") {
    do {
      code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    } while (rooms.has(code));
  }
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
    throw new Error("Xona kodi aynan 6 ta raqamdan iborat bo‘lsin.");
  }
  if (rooms.has(code)) {
    const error = new Error("Bu xona kodi band. Boshqa 6 xonali kod tanlang.");
    error.status = 409;
    throw error;
  }
  const hostToken = randomBytes(24).toString("hex");
  const room = {
    code,
    players: [{ token: hostToken, name: playerName, lastSeen: Date.now() }, null],
    started: false,
    lastSeen: Date.now(),
    lastTick: Date.now(),
    revision: 0,
    messages: [],
    nextMessageId: 1,
    game: {
      gold: [startingGold, startingGold], hp: [1000, 1000], maxHp: [1000, 1000], upgrades: [0, 0],
      upgradeLimits: [castleUpgrade.initialLimit, castleUpgrade.initialLimit],
      chain: 0, diamonds: [0, 0], damageBoosts: [1, 1], units: [],
      towers: [0, 0], towerCooldowns: [[], []],
      elapsed: 0, winner: null, nextUnitId: 1
    }
  };
  rooms.set(code, room);
  return { room, token: hostToken, player: 1 };
}

function playerFor(room, token) {
  if (!token) return null;
  const index = room.players.findIndex(player => player?.token === token);
  if (index < 0) return null;
  room.players[index].lastSeen = Date.now();
  return index;
}

function snapshot(room, afterMessageId = 0) {
  return {
    code: room.code,
    started: room.started,
    players: room.players.filter(Boolean).length,
    revision: room.revision,
    game: room.game,
    messages: room.messages.filter(message => message.id > afterMessageId)
  };
}

function updateRoom(room, dt) {
  if (!room.started || room.game.winner) return;
  const game = room.game;
  game.elapsed += dt;
  for (let side = 0; side < 2; side++) {
    game.towerCooldowns[side] = game.towerCooldowns[side].map(cooldown => cooldown - dt);
    for (let i = 0; i < game.towers[side]; i++) {
      if (game.towerCooldowns[side][i] > 0) continue;
      const targetSide = side === 0 ? "enemy" : "player";
      const castleX = side === 0 ? 90 : 910;
      const target = game.units
        .filter(unit => unit.side === targetSide && Math.abs(unit.x - castleX) <= towerSettings.range)
        .sort((a, b) => Math.abs(a.x - castleX) - Math.abs(b.x - castleX))[0];
      if (target) {
        target.hp -= towerSettings.damage;
        game.towerCooldowns[side][i] = towerSettings.interval;
      }
    }
  }
  for (const unit of game.units) {
    unit.cooldown -= dt;
    let target = null;
    let nearest = Infinity;
    for (const other of game.units) {
      if (other.side === unit.side || other.hp <= 0) continue;
      const distance = Math.abs(other.x - unit.x);
      if (distance < nearest && distance <= unit.stats.range) {
        target = other;
        nearest = distance;
      }
    }
    if (target) {
      if (unit.cooldown <= 0) {
        const victims = unit.stats.splashRadius
          ? game.units.filter(other =>
            other.side !== unit.side && other.hp > 0 &&
            Math.abs(other.x - target.x) <= unit.stats.splashRadius)
          : [target];
        for (const victim of victims) {
          victim.hp -= unit.stats.damage * game.damageBoosts[unit.side === "player" ? 0 : 1];
        }
        unit.cooldown = unit.stats.interval;
      }
      continue;
    }
    const castleIndex = unit.side === "player" ? 1 : 0;
    const targetX = unit.side === "player"
      ? 910 - 67 * castleWidthScale(game.upgrades[castleIndex])
      : 90 + 67 * castleWidthScale(game.upgrades[castleIndex]);
    const distance = Math.abs(targetX - unit.x);
    if (distance <= unit.stats.range) {
      if (unit.cooldown <= 0) {
        const castle = unit.side === "player" ? 1 : 0;
        game.hp[castle] = Math.max(
          0,
          game.hp[castle] - unit.stats.damage * game.damageBoosts[unit.side === "player" ? 0 : 1]
        );
        unit.cooldown = unit.stats.interval;
      }
    } else {
      unit.x += (unit.side === "player" ? 1 : -1) * unit.stats.speed * dt;
    }
  }
  const defeatedUnits = game.units.filter(unit => unit.hp <= 0);
  for (const unit of defeatedUnits) {
    const rewardPlayer = unit.side === "player" ? 1 : 0;
    game.gold[rewardPlayer] += unitKillRewards[unit.type];
    if (unit.type === "laser") game.diamonds[rewardPlayer] += 100;
  }
  game.units = game.units.filter(unit => unit.hp > 0);
  if (game.hp[0] <= 0) game.winner = "enemy";
  if (game.hp[1] <= 0) game.winner = "player";
  if (game.winner) {
    const winnerIndex = game.winner === "player" ? 0 : 1;
    game.gold[winnerIndex] += 10;
    game.chain += 10;
    game.diamonds[winnerIndex] += 10;
  }
  room.revision++;
}

function serveFile(response) {
  readFile(join(root, "index.html"))
    .then(contents => {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff"
      });
      response.end(contents);
    })
    .catch(error => {
      console.error("O‘yin sahifasini o‘qib bo‘lmadi:", error);
      sendJson(response, 500, { error: "O‘yin sahifasini yuklab bo‘lmadi." });
    });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  try {
    if (request.method === "GET" && url.pathname === "/api/health") {
      return sendJson(response, 200, { ok: true });
    }
    if (request.method === "POST" && url.pathname === "/api/rooms") {
      const body = await readJson(request);
      if (body.action === "create") {
        const name = normalizedPlayerName(body.name, 1);
        const { room, token, player } = createRoom(name, body.code);
        return sendJson(response, 201, { code: room.code, token, player, name, state: snapshot(room) });
      }
      if (body.action === "join") {
        const code = String(body.code || "").trim();
        const room = rooms.get(code);
        if (!/^\d{6}$/.test(code) || !room) return sendJson(response, 404, { error: "Bunday xona topilmadi." });
        if (room.started || room.players[1]) return sendJson(response, 409, { error: "Xona to‘lgan yoki jang boshlangan." });
        const name = normalizedPlayerName(body.name, 2);
        const token = randomBytes(24).toString("hex");
        room.players[1] = { token, name, lastSeen: Date.now() };
        room.started = true;
        room.lastSeen = Date.now();
        room.lastTick = Date.now();
        room.revision++;
        return sendJson(response, 200, { code, token, player: 2, name, state: snapshot(room) });
      }
      return sendJson(response, 400, { error: "Xona amali noto‘g‘ri." });
    }
    const roomMatch = url.pathname.match(/^\/api\/rooms\/(\d{6})(?:\/(action|chat))?$/);
    if (roomMatch) {
      const room = rooms.get(roomMatch[1]);
      if (!room) return sendJson(response, 404, { error: "Xona topilmadi yoki yopilgan." });
      const playerIndex = playerFor(room, request.headers["x-player-token"]);
      if (playerIndex === null) return sendJson(response, 401, { error: "Xona ruxsat kaliti noto‘g‘ri." });
      if (request.method === "GET" && !roomMatch[2]) {
        room.lastSeen = Date.now();
        const afterMessageId = Math.max(0, Number(url.searchParams.get("after")) || 0);
        return sendJson(response, 200, snapshot(room, afterMessageId));
      }
      if (request.method === "POST" && roomMatch[2] === "chat") {
        const body = await readJson(request);
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text || text.length > 200) return sendJson(response, 400, { error: "Xabar 1–200 belgi oralig‘ida bo‘lishi kerak." });
        const player = room.players[playerIndex];
        if (Date.now() - (player.lastChatAt || 0) < 700) {
          return sendJson(response, 429, { error: "Xabar yuborishdan oldin biroz kuting." });
        }
        player.lastChatAt = Date.now();
        const chatMessage = {
          id: room.nextMessageId++,
          player: playerIndex + 1,
          name: player.name,
          text,
          sentAt: Date.now()
        };
        room.messages.push(chatMessage);
        if (room.messages.length > 100) room.messages.shift();
        room.lastSeen = Date.now();
        room.revision++;
        return sendJson(response, 201, { message: chatMessage, revision: room.revision });
      }
      if (request.method === "POST" && roomMatch[2] === "action") {
        const body = await readJson(request);
        if (!room.started) return sendJson(response, 409, { error: "Ikkinchi o‘yinchi hali ulanmagan." });
        if (room.game.winner) return sendJson(response, 409, { error: "Jang allaqachon tugagan." });
        const shopOffers = {
          "shop-gold": { diamonds: 10 },
          "shop-heal": { diamonds: 25 },
          "shop-boost": { diamonds: 50 }
        };
        if (shopOffers[body.type]) {
          const offer = shopOffers[body.type];
          if (room.game.diamonds[playerIndex] < offer.diamonds) {
            return sendJson(response, 409, { error: "Olmos yetarli emas." });
          }
          if (body.type === "shop-heal" && room.game.hp[playerIndex] >= room.game.maxHp[playerIndex]) {
            return sendJson(response, 409, { error: "Qal’a joni to‘liq." });
          }
          if (body.type === "shop-boost" && room.game.damageBoosts[playerIndex] > 1) {
            return sendJson(response, 409, { error: "Ikki karra zarar kuchaytirishi bu jangda allaqachon ishlatilgan." });
          }
          room.game.diamonds[playerIndex] -= offer.diamonds;
          if (body.type === "shop-gold") room.game.gold[playerIndex] += 1000;
          if (body.type === "shop-heal") {
            room.game.hp[playerIndex] = Math.min(room.game.maxHp[playerIndex], room.game.hp[playerIndex] + 500);
          }
          if (body.type === "shop-boost") room.game.damageBoosts[playerIndex] = 2;
          room.lastSeen = Date.now();
          room.revision++;
          return sendJson(response, 200, snapshot(room));
        }
        if (body.type === "tower") {
          if (room.game.towers[playerIndex] >= towerSettings.limit) {
            return sendJson(response, 409, { error: "Qal’ada minoralar uchun joy qolmadi." });
          }
          if (room.game.gold[playerIndex] < towerCost) return sendJson(response, 409, { error: "Minora qurish uchun tanga yetarli emas." });
          room.game.gold[playerIndex] -= towerCost;
          room.game.towers[playerIndex]++;
          room.game.towerCooldowns[playerIndex].push(0);
          room.lastSeen = Date.now();
          room.revision++;
          return sendJson(response, 200, snapshot(room));
        }
        if (body.type === "upgrade") {
          if (room.game.upgrades[playerIndex] >= room.game.upgradeLimits[playerIndex]) {
            return sendJson(response, 409, { error: "Qal’a yangilash limiti tugadi." });
          }
          if (room.game.gold[playerIndex] < castleUpgrade.cost) {
            return sendJson(response, 409, { error: "Qal’ani yangilash uchun 100 tanga kerak." });
          }
          room.game.gold[playerIndex] -= castleUpgrade.cost;
          room.game.upgrades[playerIndex]++;
          if (room.game.upgrades[playerIndex] % 3 === 0) {
            room.game.upgradeLimits[playerIndex] += castleUpgrade.unlockPerThree;
          }
          room.game.maxHp[playerIndex] += castleUpgrade.hp;
          room.game.hp[playerIndex] = room.game.maxHp[playerIndex];
          room.lastSeen = Date.now();
          room.revision++;
          return sendJson(response, 200, snapshot(room));
        }
        if (body.type === "heal") {
          if (room.game.hp[playerIndex] >= room.game.maxHp[playerIndex]) {
            return sendJson(response, 409, { error: "Qal’a joni to‘liq." });
          }
          if (room.game.gold[playerIndex] < castleHeal.cost) {
            return sendJson(response, 409, { error: "Davolash uchun 40 tanga kerak." });
          }
          room.game.gold[playerIndex] -= castleHeal.cost;
          room.game.hp[playerIndex] = Math.min(
            room.game.maxHp[playerIndex],
            room.game.hp[playerIndex] + castleHeal.hp
          );
          room.lastSeen = Date.now();
          room.revision++;
          return sendJson(response, 200, snapshot(room));
        }
        const stats = unitSettings[body.type];
        if (!stats) return sendJson(response, 400, { error: "Askar turi noto‘g‘ri." });
        if (room.game.gold[playerIndex] < stats.cost) return sendJson(response, 409, { error: "Tanga yetarli emas." });
        if (room.game.units.length >= 200) return sendJson(response, 429, { error: "Jang maydonida askarlar juda ko‘p." });
        room.game.gold[playerIndex] -= stats.cost;
        room.game.units.push({
          id: room.game.nextUnitId++,
          type: body.type,
          side: playerIndex === 0 ? "player" : "enemy",
          x: playerIndex === 0
            ? 90 + 70 * castleWidthScale(room.game.upgrades[0])
            : 910 - 70 * castleWidthScale(room.game.upgrades[1]),
          hp: stats.hp,
          cooldown: 0,
          stats
        });
        room.lastSeen = Date.now();
        room.revision++;
        return sendJson(response, 200, snapshot(room));
      }
    }
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return serveFile(response);
    }
    sendJson(response, 404, { error: "Sahifa topilmadi." });
  } catch (error) {
    console.error("So‘rovni bajarib bo‘lmadi:", error);
    sendJson(response, error.status || 400, { error: error.message || "So‘rovni bajarib bo‘lmadi." });
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastSeen > 4 * 60 * 60 * 1000) {
      rooms.delete(code);
      continue;
    }
    const dt = Math.min((now - room.lastTick) / 1000, 0.1);
    room.lastTick = now;
    updateRoom(room, dt);
  }
}, 50).unref();

server.listen(port, "0.0.0.0", () => {
  console.log(`Qal'alar jangi serveri http://localhost:${port} manzilida ishga tushdi.`);
});
