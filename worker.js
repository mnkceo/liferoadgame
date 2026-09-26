import { DurableObject } from "cloudflare:workers";

const ROOM_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const readJson = async (request) => { try { return await request.json(); } catch { return {}; } };
const code4 = () => Array.from({length:4},()=>ROOM_CHARS[Math.floor(Math.random()*ROOM_CHARS.length)]).join("");

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    if (url.pathname === '/api/room/create' && request.method === 'POST') {
      const body = await readJson(request);
      for (let i=0;i<8;i++) {
        const code = code4();
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
        const res = await stub.fetch('https://room/create', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({code, seat:body.seat, mode:body.mode||'code'})});
        if (res.status === 409) continue;
        if (!res.ok) return res;
        return json({code});
      }
      return json({error:'Could not create room'},503);
    }

    if (url.pathname === '/api/room/join' && request.method === 'POST') {
      const body = await readJson(request);
      const code = String(body.code||'').toUpperCase();
      if (!/^[A-Z2-9]{4}$/.test(code)) return json({error:'Invalid room code'},400);
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      const res = await stub.fetch('https://room/join', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({seat:body.seat})});
      if (!res.ok) return res;
      return json({code});
    }

    if (url.pathname === '/api/room/info' && request.method === 'GET') {
      const code = String(url.searchParams.get('code')||'').toUpperCase();
      if (!/^[A-Z2-9]{4}$/.test(code)) return json({error:'Invalid room code'},400);
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      return stub.fetch('https://room/info');
    }

    if (url.pathname === '/api/room/ws') {
      const code = String(url.searchParams.get('code')||'').toUpperCase();
      const cid = String(url.searchParams.get('cid')||'');
      if (!/^[A-Z2-9]{4}$/.test(code) || !cid) return json({error:'Bad websocket request'},400);
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      const u = new URL('https://room/ws'); u.searchParams.set('cid',cid);
      return stub.fetch(new Request(u, request));
    }

    if (url.pathname === '/api/match/find' && request.method === 'POST') {
      const body = await readJson(request);
      const stub = env.MATCHMAKER.get(env.MATCHMAKER.idFromName('global'));
      return stub.fetch('https://match/find', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({seat:body.seat})});
    }

    return json({error:'Not found'},404);
  }
};

export class GameRoom extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.ctx = ctx; this.env = env; }

  async getData() {
    const room = await this.ctx.storage.get('room');
    const seats = (await this.ctx.storage.get('seats')) || [];
    return {room, seats};
  }
  async save(room, seats) {
    await this.ctx.storage.put({room, seats});
  }
  async broadcast() {
    const data = await this.getData();
    const message = JSON.stringify({type:'snapshot', room:data.room, seats:data.seats});
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(message); } catch {} }
  }
  async fetch(request) {
    const url = new URL(request.url);
    const {room, seats} = await this.getData();

    if (url.pathname === '/create' && request.method === 'POST') {
      if (room) return json({error:'exists'},409);
      const body = await readJson(request);
      const seat = body.seat;
      if (!seat?.cid) return json({error:'Invalid player'},400);
      const now = Date.now();
      const newRoom = {code:body.code,status:'lobby',hostId:seat.cid,createdAt:now,updatedAt:now,rev:0,game:null,event:null,mode:body.mode||'code'};
      await this.save(newRoom,[seat]);
      return json({ok:true});
    }

    if (url.pathname === '/join' && request.method === 'POST') {
      if (!room) return json({error:'Room not found'},404);
      const body = await readJson(request); const seat = body.seat;
      if (!seat?.cid) return json({error:'Invalid player'},400);
      const idx = seats.findIndex(s=>s.cid===seat.cid);
      if (room.status !== 'lobby' && idx < 0) return json({error:'Game already started'},409);
      if (idx < 0 && seats.length >= 4) return json({error:'Room full'},409);
      const next = seats.slice();
      if (idx >= 0) next[idx] = {...next[idx],...seat}; else next.push(seat);
      room.updatedAt = Date.now();
      await this.save(room,next); await this.broadcast();
      return json({ok:true,count:next.length});
    }

    if (url.pathname === '/info') {
      if (!room) return json({error:'Room not found'},404);
      return json({room,seats});
    }

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return json({error:'Expected websocket'},426);
      if (!room) return json({error:'Room not found'},404);
      const cid = url.searchParams.get('cid');
      if (!seats.some(s=>s.cid===cid)) return json({error:'Not a room member'},403);
      const pair = new WebSocketPair(); const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({cid});
      server.send(JSON.stringify({type:'snapshot',room,seats}));
      return new Response(null,{status:101,webSocket:client});
    }
    return json({error:'Not found'},404);
  }

  async webSocketMessage(ws, message) {
    let msg; try { msg = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message)); } catch { return; }
    const attachment = ws.deserializeAttachment() || {}; const cid = attachment.cid;
    let {room,seats} = await this.getData();
    if (!room || !seats.some(s=>s.cid===cid)) return;

    if (msg.type === 'seat' && msg.seat?.cid === cid) {
      const i=seats.findIndex(s=>s.cid===cid); seats[i]={...seats[i],...msg.seat}; room.updatedAt=Date.now();
    } else if (msg.type === 'start') {
      if (room.hostId!==cid || seats.length<2 || !msg.game) return;
      room.status='playing'; room.rev=(room.rev||0)+1; room.game=msg.game; room.event=null; room.updatedAt=Date.now();
    } else if (msg.type === 'state') {
      if (!msg.game || !['playing','over'].includes(msg.status)) return;
      room.status=msg.status; room.rev=Math.max((room.rev||0)+1, Number(msg.rev)||0); room.game=msg.game; room.updatedAt=Date.now();
    } else if (msg.type === 'event' && msg.event) {
      room.event=msg.event; room.updatedAt=Date.now();
    } else if (msg.type === 'back') {
      if (room.hostId!==cid) return;
      room.status='lobby'; room.rev=(room.rev||0)+1; room.game=null; room.event=null; room.updatedAt=Date.now();
    } else if (msg.type === 'leave') {
      seats=seats.filter(s=>s.cid!==cid); room.updatedAt=Date.now();
      if (!seats.length) { await this.ctx.storage.deleteAll(); try{ws.close(1000,'left')}catch{}; return; }
      if (room.hostId===cid) room.hostId=seats[0].cid;
      try{ws.close(1000,'left')}catch{}
    } else return;

    await this.save(room,seats); await this.broadcast();
  }

  async webSocketClose() {}
  async webSocketError() {}
}

export class Matchmaker extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.ctx=ctx; this.env=env; }
  async fetch(request) {
    const url=new URL(request.url);
    if (url.pathname!=='/find' || request.method!=='POST') return json({error:'Not found'},404);
    const body=await readJson(request); const seat=body.seat;
    if (!seat?.cid) return json({error:'Invalid player'},400);

    let code=await this.ctx.storage.get('waitingCode');
    if (code) {
      const room=this.env.ROOMS.get(this.env.ROOMS.idFromName(code));
      const joined=await room.fetch('https://room/join',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({seat})});
      if (joined.ok) return json({code,created:false});
      await this.ctx.storage.delete('waitingCode');
    }

    for(let i=0;i<8;i++) {
      code=code4();
      const room=this.env.ROOMS.get(this.env.ROOMS.idFromName(code));
      const created=await room.fetch('https://room/create',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code,seat,mode:'random'})});
      if(created.status===409) continue;
      if(!created.ok) return created;
      await this.ctx.storage.put('waitingCode',code);
      return json({code,created:true});
    }
    return json({error:'Could not find match'},503);
  }
}
