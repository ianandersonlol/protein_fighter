// Remote play: two devices, one fight. The host runs the whole game and streams the
// state; the guest sends its key presses and draws what it is sent. The link between
// them is a WebRTC data channel set up through PeerJS's public signaling server, and
// the guest gets in by scanning a QR code of the host's join link (or opening it).
(function () {
  let peer = null, conn = null, timer = 0;
  let player = null, rtt = 0, pinger = 0;
  const watchers = new Set();

  // Where the two browsers find a route to each other: PeerJS's defaults, which are
  // Google's STUN servers and PeerJS's own TURN relays for when no direct path exists.
  // A TURN server of your own can be given as ?turn=turn:host:port&tu=user&tp=password
  // on the host's page; the join link carries it to the guest.
  const params = new URLSearchParams(location.search);
  const TURN = params.get('turn') ? { urls: params.get('turn'), username: params.get('tu') || '', credential: params.get('tp') || '' } : null;
  const ICE = TURN ? { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }, TURN] } : null;
  if (ICE && params.get('relay')) ICE.iceTransportPolicy = 'relay';   // ?relay=1 with a TURN of your own: use only the relay
  const turnQuery = () => TURN ? `&turn=${encodeURIComponent(TURN.urls)}&tu=${encodeURIComponent(TURN.username)}&tp=${encodeURIComponent(TURN.credential)}` : '';
  // The channel keeps at most this much unsent: when the link can't keep up, packets are
  // dropped rather than queued, so the guest sees a late frame instead of an ever later one.
  const MAX_QUEUED = 48 * 1024;
  // What went wrong, from the connection itself, for the message on screen.
  const why = c => {
    const pc = c && c.peerConnection;
    if (!pc) return 'no connection was attempted';
    return `ICE ${pc.iceConnectionState}, connection ${pc.connectionState}, signaling ${pc.signalingState}`;
  };
  // The link as it stands, for the status line: the connection's state and how much is
  // waiting to go out.
  const status = () => {
    if (!conn) return null;
    const pc = conn.peerConnection, dc = conn.dataChannel;
    return { open: !!conn.open, ice: pc ? pc.iceConnectionState : '-', queued: dc ? dc.bufferedAmount : 0 };
  };
  const OPEN_TIMEOUT = 20000;   // ms for the data channel to open before giving up
  const newPeer = () => ICE ? new Peer({ config: ICE }) : new Peer();

  const joinId = () => new URLSearchParams(location.search).get('join');
  const joinLink = id => `${location.origin}${location.pathname}?join=${encodeURIComponent(id)}${turnQuery()}`;

  // Draw the join link as a QR code into `el` (qrcode-generator, if it loaded).
  function showQR(el, link) {
    el.innerHTML = '';
    if (typeof qrcode === 'undefined') return false;
    try {
      const qr = qrcode(0, 'M');
      qr.addData(link); qr.make();
      el.innerHTML = qr.createImgTag(5, 8);
      return true;
    } catch (e) { console.warn('QR code failed', e); return false; }
  }

  function stop() {
    clearInterval(pinger); pinger = 0;
    for (const w of watchers) { try { w.close(); } catch {} } watchers.clear(); player = null;
    try { conn && conn.close(); } catch {}
    try { peer && peer.destroy(); } catch {}
    clearTimeout(timer); timer = 0;
    conn = peer = null;
  }

  // Host: get an id from the signaling server, hand back the join link, and take
  // connections: one player (the guest), any number of watchers. Each says which it is
  // in a hello. A player that drops can come back on the same link; the host's id lives
  // on. Messages from the player arrive on onInput; the returned send() streams state to
  // everyone. Pings from the player are answered here and its round trip reported.
  function host({ onLink, onGuest, onWatcher, onInput, onClose, onError, onPing }) {
    stop();
    if (typeof Peer === 'undefined') { onError('The connection library did not load. Is the network up?'); return null; }
    peer = newPeer();
    peer.on('open', id => onLink(joinLink(id)));
    peer.on('error', e => onError(String(e && e.type || e)));
    peer.on('connection', c => {
      let role = null;
      const t = setTimeout(() => { if (!c.open) { try { c.close(); } catch {} } }, OPEN_TIMEOUT);
      c.on('open', () => clearTimeout(t));
      c.on('data', m => {
        if (!m) return;
        if (m.t === 'hello') {
          if (m.role === 'watch') { role = 'watch'; watchers.add(c); onWatcher && onWatcher(watchers.size); return; }
          if (player && player.open) { try { c.close(); } catch {} return; }   // one challenger at a time
          role = 'player'; player = conn = c; onGuest(); return;
        }
        if (m.t === 'ping') { if (role === 'player') { rtt = m.rtt || 0; onPing && onPing(rtt); } try { c.send({ t: 'pong', k: m.k }); } catch {} return; }
        if (role === 'player') onInput(m);
      });
      c.on('close', () => { if (role === 'watch') { watchers.delete(c); onWatcher && onWatcher(watchers.size); } else if (c === player) { player = conn = null; onClose(); } });
      c.on('error', e => onError(String(e)));
    });
    const to = (c, m) => { if (!c || !c.open) return; const dc = c.dataChannel; if (dc && dc.bufferedAmount > MAX_QUEUED) return; try { c.send(m); } catch (e) { console.error('send failed', e); } };
    return { send: m => { to(player, m); for (const w of watchers) to(w, m); } };
  }

  // Guest (or watcher): connect to the host's id and say which. State arrives on
  // onState; the returned send() carries key presses back. A ping a second measures
  // the round trip (Net.rtt()).
  function join(id, { onOpen, onState, onClose, onError, role = 'player' }) {
    stop();
    if (typeof Peer === 'undefined') { onError('The connection library did not load. Is the network up?'); return null; }
    peer = newPeer();
    peer.on('error', e => onError(String(e && e.type || e)));
    peer.on('open', () => {
      conn = peer.connect(id, { reliable: true });
      timer = setTimeout(() => { if (!conn || !conn.open) onError(`No route to the host after 20 s (${why(conn)}). The two networks would not connect directly, and PeerJS's public relay is not answering (measured: it hands out no relay candidates). Home Wi-Fi usually connects; a phone on cellular data often cannot. A TURN relay of your own gets past it: add ?turn=turn:host:port&tu=user&tp=password to the host's page before pressing REMOTE.`); }, OPEN_TIMEOUT);
      conn.on('open', () => {
        clearTimeout(timer);
        try { conn.send({ t: 'hello', role }); } catch {}
        pinger = setInterval(() => { if (conn && conn.open) try { conn.send({ t: 'ping', k: performance.now(), rtt }); } catch {} }, 1000);
        onOpen();
      });
      conn.on('data', m => { if (m && m.t === 'pong') rtt = Math.round(performance.now() - m.k); else onState(m); });
      conn.on('close', () => { clearInterval(pinger); onClose(); });
      conn.on('error', e => onError(String(e)));
    });
    return { send: m => { if (!conn || !conn.open) return; try { conn.send(m); } catch (e) { console.error('send failed', e); } } };
  }

  const watching = () => !!new URLSearchParams(location.search).get('watch');
  window.Net = { joinId, watching, host, join, stop, showQR, status, rtt: () => rtt };
})();
