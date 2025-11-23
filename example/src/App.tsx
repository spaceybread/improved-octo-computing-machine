import * as React from 'react';
import { useState, useEffect, useRef } from 'react';
import {
  Button,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  Switch,
  Alert,
  ScrollView,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  initSession,
  PeerState,
} from 'react-native-multipeer-connectivity';
import { produce } from 'immer';

export default function App() {
  const [displayName, setDisplayName] = useState('');
  const [persistentID, setPersistentID] = useState('');
  const [peerID, setPeerID] = useState('');
  const [isBrowsing, setIsBrowsing] = useState(false);
  const [isAdvertising, setIsAdvertising] = useState(false);
  const [peers, setPeers] = useState({});
  const [receivedMessages, setReceivedMessages] = useState({});
  const [session, setSession] = useState(null);

  const [knownGraph, setKnownGraph] = useState({});
  const seenMessageIdsRef = useRef(new Set());
  const DEFAULT_TTL = 5;

  const generateID = () =>
    Date.now().toString(36) + Math.random().toString(36).substring(2, 10);

  useEffect(() => {
    (async () => {
      let storedID = await AsyncStorage.getItem('persistentPeerID');
      if (!storedID) {
        storedID = generateID();
        await AsyncStorage.setItem('persistentPeerID', storedID);
      }
      setPersistentID(storedID);
    })();
  }, []);

  // --- Session events ---
  useEffect(() => {
    if (!session) return;

    const r1 = session.onStartAdvertisingError(() => setIsAdvertising(false));
    const r2 = session.onStartBrowsingError(() => setIsBrowsing(false));

    const r3 = session.onFoundPeer((ev) => {
      setPeers((draft) =>
        produce(draft, (d) => {
          if (!d[ev.peer.id])
            d[ev.peer.id] = { peer: ev.peer, state: PeerState.notConnected, discoveryInfo: ev.discoveryInfo };
        })
      );
      if (ev.discoveryInfo) {
        setKnownGraph((g) =>
          produce(g, (draft) => {
            draft[ev.peer.id] = draft[ev.peer.id] || { displayName: ev.discoveryInfo.myName || ev.peer.displayName, neighbors: [] };
          })
        );
      }
    });

    const r4 = session.onLostPeer((ev) => {
      setPeers((draft) =>
        produce(draft, (d) => { delete d[ev.peer.id]; })
      );
      setKnownGraph((g) =>
        produce(g, (draft) => {
          if (draft[peerID]) draft[peerID].neighbors = (draft[peerID].neighbors || []).filter(n => n !== ev.peer.id);
        })
      );
      broadcastGraphDebounced();
    });

    const r5 = session.onPeerStateChanged((ev) => {
      setPeers((draft) =>
        produce(draft, (d) => {
          if (d[ev.peer.id]) d[ev.peer.id].state = ev.state;
          else d[ev.peer.id] = { peer: ev.peer, state: ev.state };
        })
      );
      setKnownGraph((g) =>
        produce(g, (draft) => {
          draft[peerID] = draft[peerID] || { displayName, neighbors: [] };
          if (ev.state === PeerState.connected) {
            if (!draft[peerID].neighbors.includes(ev.peer.id)) draft[peerID].neighbors.push(ev.peer.id);
            draft[ev.peer.id] = draft[ev.peer.id] || { displayName: ev.peer.displayName || ev.peer.id, neighbors: [] };
          } else {
            draft[peerID].neighbors = (draft[peerID].neighbors || []).filter(n => n !== ev.peer.id);
          }
        })
      );
      broadcastGraphDebounced();
    });

    const r6 = session.onReceivedPeerInvitation((ev) => ev.handler(true));

    const r7 = session.onReceivedText((ev) => {
      let parsed = null;
      try { parsed = JSON.parse(ev.text); } catch (e) { parsed = null; }

      if (parsed && parsed.type === 'relay') handleRelay(parsed, ev.peer.id);
      else pushReceived(ev.peer.id, ev.text);
    });

    return () => {
      try { session.stopAdvertizing(); session.stopBrowsing(); } catch (e) {}
      r1.remove(); r2.remove(); r3.remove(); r4.remove(); r5.remove(); r6.remove(); r7.remove();
    };
  }, [session, peerID, displayName]);

  // --- Helper functions ---
  const pushReceived = (fromId, text) => {
    setReceivedMessages(prev => produce(prev, d => { (d[fromId] ||= []).push(text); }));
  };

  useEffect(() => {
    if (!displayName || !persistentID) return;
    if (session) return;

    const s = initSession({
      displayName,
      serviceType: 'demo',
      discoveryInfo: { myPersistentID: persistentID, myName: displayName, joinAt: Date.now().toString() },
    });

    setSession(s);
    setPeerID(s.peerID);

    setKnownGraph((g) => produce(g, d => { d[s.peerID] = d[s.peerID] || { displayName, neighbors: [] }; }));
  }, [displayName, persistentID]);

  const broadcastGraph = () => {
    if (!session || !peerID) return;
    const payload = JSON.stringify({
      type: 'peerGraph',
      data: {
        me: { id: peerID, name: displayName },
        neighbors: knownGraph[peerID]?.neighbors || Object.keys(peers).filter(id => peers[id].state === PeerState.connected),
        knownPeers: knownGraph,
      },
    });
    Object.entries(peers).forEach(([id, info]) => { if (info.state === PeerState.connected) session.sendText(id, payload); });
  };

  const graphBroadcastTimerRef = useRef(null);
  const broadcastGraphDebounced = () => {
    if (graphBroadcastTimerRef.current) clearTimeout(graphBroadcastTimerRef.current);
    graphBroadcastTimerRef.current = setTimeout(() => { broadcastGraph(); graphBroadcastTimerRef.current = null; }, 200);
  };

  const handleRelay = (msg, fromPeerId) => {
    if (!msg || !msg.id) return;
    const seen = seenMessageIdsRef.current;
    if (seen.has(msg.id)) return;
    seen.add(msg.id);

    // Only display if dst matches my peerID
    if (msg.dst === peerID) pushReceived(msg.src || fromPeerId, `[flood-delivered] ${msg.text}`);

    // Forward to all connected neighbors except sender
    if (msg.ttl > 0) {
      const forward = { ...msg, ttl: msg.ttl - 1 };
      Object.entries(peers).forEach(([id, info]) => {
        if (info.state === PeerState.connected && id !== fromPeerId) {
          try { session?.sendText(id, JSON.stringify(forward)); } catch (e) {}
        }
      });
    }
  };

  const sendMultiHop = (targetId, text) => {
    if (!session || !peerID || !targetId || !text.trim()) return;
    const msgId = generateID();
    const msg = { type: 'relay', id: msgId, src: peerID, dst: targetId, ttl: DEFAULT_TTL, text };
    seenMessageIdsRef.current.add(msgId);

    Object.entries(peers).forEach(([id, info]) => { if (info.state === PeerState.connected) session.sendText(id, JSON.stringify(msg)); });
    pushReceived(targetId, `(sent, flood) ${text}`);
  };

  const [mhTarget, setMhTarget] = useState('');
  const [mhText, setMhText] = useState('');
  const directTextRef = useRef({});

  // --- Auto refresh every second ---
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  const [blacklist, setBlacklist] = useState([]);

  // --- Render ---
  if (!displayName || !persistentID) {
    return (
      <View style={styles.container}>
        <Text style={{ fontSize: 20, marginBottom: 8 }}>Enter your display name:</Text>
        <TextInput style={{ fontSize: 20, borderWidth: 1, padding: 10, width: 320 }} placeholder="display name"
          onSubmitEditing={(ev) => { const name = ev.nativeEvent.text.trim(); if (!name) return; setDisplayName(name); }}
        />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={{ fontSize: 16, marginBottom: 6 }}>You: {displayName}</Text>
      <Text style={{ fontSize: 12, marginBottom: 12 }}>persistentID: {persistentID}</Text>

      <View style={{ marginVertical: 12 }}>
        <View style={styles.toggleRow}><Text>Browsing</Text>
          <Switch value={isBrowsing} onValueChange={(v) => { setIsBrowsing(v); v ? session?.browse() : session?.stopBrowsing(); }} />
        </View>
        <View style={styles.toggleRow}><Text>Advertising</Text>
          <Switch value={isAdvertising} onValueChange={(v) => { setIsAdvertising(v); v ? session?.advertize() : session?.stopAdvertizing(); }} />
        </View>
      </View>

      <Button title="Disconnect" onPress={() => { session?.disconnect(); setPeers({}); setKnownGraph((g) => produce(g, d => { if (d[peerID]) d[peerID].neighbors = []; })); }} />

      <View style={{ marginTop: 18, width: '92%' }}>
        <Text style={{ fontWeight: '700' }}>Found peers (direct + indirect)</Text>
        {Object.entries(knownGraph).length === 0 && <Text style={{ fontStyle: 'italic' }}>none</Text>}
        {Object.entries(knownGraph).map(([id, info]) => (
          <View key={id} style={styles.peerBox}>
            <Text style={{ fontWeight: '600' }}>{info.displayName || id}</Text>
            <Text style={{ fontSize: 12 }}>{id} {id === peerID ? '(you)' : ''}</Text>
            <Text style={{ fontSize: 12 }}>neighbors: {(info.neighbors || []).join(', ')}</Text>
            <Pressable onPress={() => setMhTarget(id)} style={{ marginTop: 6 }}>
              <Text>Pick as multi-hop target</Text>
            </Pressable>
          </View>
        ))}
      </View>

      <View style={{ marginTop: 18, width: '92%' }}>
        <Text style={{ fontWeight: '700' }}>Send multi-hop message (flood)</Text>
        <Text style={{ fontSize: 12, marginBottom: 6 }}>Target UUID: {mhTarget || '(choose from peers)'}</Text>
        <TextInput placeholder="target UUID" style={{ borderWidth: 1, padding: 8, marginBottom: 6 }} value={mhTarget} onChangeText={setMhTarget} />
        <TextInput placeholder="message" style={{ borderWidth: 1, padding: 8, marginBottom: 6 }} value={mhText} onChangeText={setMhText} />
        <Button title="Send (multi-hop flood)" onPress={() => { if (!mhTarget || !mhText.trim()) return; sendMultiHop(mhTarget, mhText); setMhText(''); }} />
      </View>

      <View style={{ marginTop: 18, width: '92%', marginBottom: 60 }}>
        <Text style={{ fontWeight: '700' }}>Messages stored</Text>
        {Object.keys(receivedMessages).length === 0 && <Text style={{ fontStyle: 'italic' }}>none</Text>}
        {Object.entries(receivedMessages).map(([from, arr]) => (
          <View key={from} style={{ marginTop: 8 }}>
            <Text style={{ fontWeight: '700' }}>{from}</Text>
            {arr.map((m, i) => <Text key={i} style={{ paddingLeft: 8 }}>{m}</Text>)}
          </View>
        ))}
      </View>
      <TextInput
      placeholder="Enter blacklist UUIDs, comma separated"
      style={{ borderWidth: 1, padding: 8, marginVertical: 8 }}
      value={blacklist.join(',')}
      onChangeText={(text) => setBlacklist(text.split(',').map(s => s.trim()))}
      />

    <Button
      title="Send direct"
      onPress={() => {
        const t = directTextRef.current[id] || '';
        if (!t.trim()) return;

        if (blacklist.includes(id)) {
          Alert.alert("Blacklisted!", `Cannot send direct message to ${id}, but multi-hop works.`);
          return;
        }

        session.sendText(id, t);
        pushReceived(id, `(direct) ${t}`);
        directTextRef.current[id] = '';
      }}
    />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { paddingTop: 80, alignItems: 'center', justifyContent: 'flex-start', backgroundColor: 'white', paddingBottom: 80 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', width: 200, marginVertical: 10 },
  peerBox: { borderWidth: 1, padding: 8, marginVertical: 10, width: '100%' },
});


