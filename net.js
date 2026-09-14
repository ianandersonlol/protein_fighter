// Remote play: two devices, one fight. The host runs the whole game and streams the
// state; the guest sends its key presses and draws what it is sent. The link between
// them is a WebRTC data channel set up through PeerJS's public signaling server, and
// the guest gets in by scanning a QR code of the host's join link (or opening it).
(function () {
  let peer = null, conn = null, timer = 0;

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
    try { conn && conn.close(); } catch {}
    try { peer && peer.destroy(); } catch {}
    clearTimeout(timer); timer = 0;
    conn = peer = null;
  }

  // Host: get an id from the signaling server, hand back the join link, wait for one
  // guest. Messages from the guest arrive on onInput; the returned send() streams state.
  function host({ onLink, onGuest, onInput, onClose, onError }) {
    stop();
    if (typeof Peer === 'undefined') { onError('The connection library did not load. Is the network up?'); return null; }
    peer = newPeer();
    peer.on('open', id => onLink(joinLink(id)));
    peer.on('error', e => onError(String(e && e.type || e)));
    peer.on('connection', c => {
      if (conn) { c.close(); return; }   // one challenger
      conn = c;
      timer = setTimeout(() => { if (!c.open) { const w = why(c); try { c.close(); } catch {} conn = null; onError(`The challenger could not reach you (${w}). A firewall or strict NAT may be in the way; a TURN relay would get past it.`); } }, OPEN_TIMEOUT);
      c.on('open', () => { clearTimeout(timer); onGuest(); });
      c.on('data', m => onInput(m));
      c.on('close', () => { conn = null; onClose(); });
      c.on('error', e => onError(String(e)));
    });
    return { send: m => { if (!conn || !conn.open) return; const dc = conn.dataChannel; if (dc && dc.bufferedAmount > MAX_QUEUED) return; try { conn.send(m); } catch (e) { console.error('send failed', e); } } };
  }

  // Guest: connect to the host's id. State arrives on onState; the returned send()
  // carries key presses back.
  function join(id, { onOpen, onState, onClose, onError }) {
    stop();
    if (typeof Peer === 'undefined') { onError('The connection library did not load. Is the network up?'); return null; }
    peer = newPeer();
    peer.on('error', e => onError(String(e && e.type || e)));
    peer.on('open', () => {
      conn = peer.connect(id, { reliable: true });
      timer = setTimeout(() => { if (!conn || !conn.open) onError(`No route to the host after 20 s (${why(conn)}). A firewall or strict NAT may be in the way; a TURN relay would get past it.`); }, OPEN_TIMEOUT);
      conn.on('open', () => { clearTimeout(timer); onOpen(); });
      conn.on('data', m => onState(m));
      conn.on('close', () => onClose());
      conn.on('error', e => onError(String(e)));
    });
    return { send: m => { if (conn && conn.open) try { conn.send(m); } catch (e) { console.error('send failed', e); } } };
  }

  window.Net = { joinId, host, join, stop, showQR, status };
})();
