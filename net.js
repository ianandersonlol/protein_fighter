// Remote play: two devices, one fight. The host runs the whole game and streams the
// state; the guest sends its key presses and draws what it is sent. The link between
// them is a WebRTC data channel set up through PeerJS's public signaling server, and
// the guest gets in by scanning a QR code of the host's join link (or opening it).
(function () {
  let peer = null, conn = null;

  const joinId = () => new URLSearchParams(location.search).get('join');
  const joinLink = id => `${location.origin}${location.pathname}?join=${encodeURIComponent(id)}`;

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
    conn = peer = null;
  }

  // Host: get an id from the signaling server, hand back the join link, wait for one
  // guest. Messages from the guest arrive on onInput; the returned send() streams state.
  function host({ onLink, onGuest, onInput, onClose, onError }) {
    stop();
    if (typeof Peer === 'undefined') { onError('The connection library did not load. Is the network up?'); return null; }
    peer = new Peer();
    peer.on('open', id => onLink(joinLink(id)));
    peer.on('error', e => onError(String(e && e.type || e)));
    peer.on('connection', c => {
      if (conn) { c.close(); return; }   // one challenger
      conn = c;
      c.on('open', () => onGuest());
      c.on('data', m => onInput(m));
      c.on('close', () => { conn = null; onClose(); });
      c.on('error', e => onError(String(e)));
    });
    return { send: m => { if (conn && conn.open) try { conn.send(m); } catch (e) { console.error('send failed', e); } } };
  }

  // Guest: connect to the host's id. State arrives on onState; the returned send()
  // carries key presses back.
  function join(id, { onOpen, onState, onClose, onError }) {
    stop();
    if (typeof Peer === 'undefined') { onError('The connection library did not load. Is the network up?'); return null; }
    peer = new Peer();
    peer.on('error', e => onError(String(e && e.type || e)));
    peer.on('open', () => {
      conn = peer.connect(id, { reliable: true });
      conn.on('open', () => onOpen());
      conn.on('data', m => onState(m));
      conn.on('close', () => onClose());
      conn.on('error', e => onError(String(e)));
    });
    return { send: m => { if (conn && conn.open) try { conn.send(m); } catch (e) { console.error('send failed', e); } } };
  }

  window.Net = { joinId, host, join, stop, showQR };
})();
