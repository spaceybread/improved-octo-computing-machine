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
  RNPeer,
} from 'react-native-multipeer-connectivity';
import { produce } from 'immer';

/**
 * Flooding mesh implementation (Bluetooth-style):
 * - peers broadcast a 'peerGraph' JSON message (their view of known peers)
 * - chat messages are sent as 'relay' JSON messages: { type:'relay', id, src, dst, ttl, text }
 * - each node dedups using seenMessageIds and forwards relay to ALL connected neighbors except the one it received from
 * - TTL bounds flood scope
 *
 * Instructions:
 * - Paste into App.js
 * - Run on multiple devices/emulators supporting MultipeerConnectivity
 */

export default function App() {
  const [displayName, setDisplayName] = useState('');
  const [persistentID, setPersistentID] = useState('');
  const [peerID, setPeerID] = useState('');
  const [isBrowsing, setIsBrowsing] = useState(false);
  const [isAdvertising, setIsAdvertising] = useState(false);
  const [peers, setPeers] = useState<
    Record<
      string,
      { state: PeerState; peer: RNPeer; discoveryInfo?: Record<string, string> }
    >
  >({});
  const [receivedMessages, setReceivedMessages] = useState<
    Record<string, string[]>
  >({});
  const [session, setSession] = useState<null | ReturnType<typeof initSession>>(
    null
  );

  // Distributed known graph we keep via gossip:
  // knownGraph[peerID] = { displayName: string, neighbors: string[] }
  const [knownGraph, setKnownGraph] = useState<Record<string, { displayName?: string; neighbors: string[] }>>({});

  // simple persistent/generation ID
  const generateID = () =>
    Date.now().toString(36) + Math.random().toString(36).substring(2, 10);

  // seen message ids for deduping flood
  const seenMessageIdsRef = useRef(new Set<string>());

  // TTL for flooded messages
  const DEFAULT_TTL = 5;

  // Load or generate persistent ID
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

  // --- session event wiring ---
  useEffect(() => {
    if (!session) return;

    const r1 = session.onStartAdvertisingError(() => setIsAdvertising(false));
    const r2 = session.onStartBrowsingError(() => setIsBrowsing(false));

    const r3 = session.onFoundPeer((ev) => {
      setPeers(
        produce((draft) => {
          if (!draft[ev.peer.id]) {
            draft[ev.peer.id] = {
              peer: ev.peer,
              state: PeerState.notConnected,
              discoveryInfo: ev.discoveryInfo,
            };
          } else {
            draft[ev.peer.id].discoveryInfo = ev.discoveryInfo;
          }
        })
      );

      // If discoveryInfo contains persistentID/name, merge into knownGraph
      if (ev.discoveryInfo) {
        const pid = ev.peer.id;
        setKnownGraph((g) =>
          produce(g, (draft) => {
            draft[pid] = draft[pid] || { displayName: ev.discoveryInfo?.myName || ev.peer.displayName || pid, neighbors: [] };
            // keep discoveryInfo.persistent or joinAt if desired
          })
        );
      }
    });

    const r4 = session.onLostPeer((ev) => {
      setPeers(
        produce((draft) => {
          delete draft[ev.peer.id];
        })
      );

      // remove as neighbor from our graph (but retain node entry)
      setKnownGraph((g) =>
        produce(g, (draft) => {
          if (draft[peerID]) {
            draft[peerID].neighbors = (draft[peerID].neighbors || []).filter((n) => n !== ev.peer.id);
          }
        })
      );

      // broadcast updated graph to neighbors
      broadcastGraphDebounced();
    });

    const r5 = session.onPeerStateChanged((ev) => {
      setPeers(
        produce((draft) => {
          if (draft[ev.peer.id]) draft[ev.peer.id].state = ev.state;
          else draft[ev.peer.id] = { peer: ev.peer, state: ev.state };
        })
      );

      // update knownGraph neighbor lists
      setKnownGraph((g) =>
        produce(g, (draft) => {
          draft[peerID] = draft[peerID] || { displayName, neighbors: [] };

          if (ev.state === PeerState.connected) {
            if (!draft[peerID].neighbors.includes(ev.peer.id)) draft[peerID].neighbors.push(ev.peer.id);
            // ensure remote node exists
            draft[ev.peer.id] = draft[ev.peer.id] || { displayName: ev.peer.displayName || ev.peer.id, neighbors: [] };
          } else {
            draft[peerID].neighbors = (draft[peerID].neighbors || []).filter((n) => n !== ev.peer.id);
          }
        })
      );

      // broadcast new graph state to neighbors
      broadcastGraphDebounced();
    });

    const r6 = session.onReceivedPeerInvitation((ev) => ev.handler(true));

    const r7 = session.onReceivedText((ev) => {
      // incoming text might be plain string (old direct behaviour) or JSON typed
      let parsed = null;
      try {
        parsed = JSON.parse(ev.text);
      } catch (e) {
        parsed = null;
      }

      // If it's typed message
      if (parsed && parsed.type) {
        if (parsed.type === 'peerGraph') {
          // parsed.data is the remote's graph
          handleIncomingGraph(parsed.data, ev.peer.id);
        } else if (parsed.type === 'relay') {
          handleRelay(parsed, ev.peer.id);
        } else {
          // unknown typed message: just store as message text
          pushReceived(ev.peer.id, ev.text);
        }
      } else {
        // legacy plain text: show as direct message
        pushReceived(ev.peer.id, ev.text);
      }
    });

    return () => {
      try {
        session.stopAdvertizing();
        session.stopBrowsing();
      } catch (e) {
        // ignore
      }
      r1.remove();
      r2.remove();
      r3.remove();
      r4.remove();
      r5.remove();
      r6.remove();
      r7.remove();
    };
  }, [session, peerID, displayName]);

  // --- helpers for messages/state ---
  const pushReceived = (fromId: string, text: string) => {
    setReceivedMessages((prev) =>
      produce(prev, (draft) => {
        (draft[fromId] ||= []).push(text);
      })
    );
  };

  // When user sets display name -> init session
  useEffect(() => {
    if (!displayName || !persistentID) return;

    if (session) return; // already initialized

    const s = initSession({
      displayName,
      serviceType: 'demo',
      discoveryInfo: {
        myPersistentID: persistentID,
        myName: displayName,
        joinAt: Date.now().toString(),
      },
    });

    setSession(s);
    setPeerID(s.peerID);

    // initialize own knownGraph entry
    setKnownGraph((g) =>
      produce(g, (draft) => {
        draft[s.peerID] = draft[s.peerID] || { displayName, neighbors: [] };
      })
    );
  }, [displayName, persistentID]);

  // --- GOSSIP: broadcast our knownGraph to direct neighbors ---
  const broadcastGraph = () => {
    if (!session || !peerID) return;
    const payload = JSON.stringify({
      type: 'peerGraph',
      data: {
        me: { id: peerID, name: displayName },
        neighbors: knownGraph[peerID]?.neighbors || Object.keys(peers).filter((id) => peers[id].state === PeerState.connected),
        knownPeers: knownGraph,
      },
    });

    Object.entries(peers).forEach(([id, info]) => {
      if (info.state === PeerState.connected) {
        try {
          session.sendText(id, payload);
        } catch (e) {
          // ignore send errors
        }
      }
    });
  };

  // Debounce helper to avoid flooding graph updates locally
  const graphBroadcastTimerRef = useRef<number | null>(null);
  const broadcastGraphDebounced = () => {
    if (graphBroadcastTimerRef.current) {
      clearTimeout(graphBroadcastTimerRef.current);
    }
    // @ts-ignore - setTimeout returns number in RN
    graphBroadcastTimerRef.current = setTimeout(() => {
      broadcastGraph();
      graphBroadcastTimerRef.current = null;
    }, 200);
  };

  // Handle incoming graph gossip from another peer
  const handleIncomingGraph = (remoteGraph: any, fromPeerId: string) => {
    // remoteGraph: { me: { id, name }, neighbors: [...], knownPeers: { id: { displayName, neighbors } } }
    setKnownGraph((g) =>
      produce(g, (draft) => {
        if (remoteGraph.me) {
          const mid = remoteGraph.me.id;
          draft[mid] = draft[mid] || { displayName: remoteGraph.me.name || mid, neighbors: [] };
          // merge neighbor lists
          if (Array.isArray(remoteGraph.neighbors)) {
            draft[mid].neighbors = Array.from(new Set([...(draft[mid].neighbors || []), ...remoteGraph.neighbors]));
          }
        }
        if (remoteGraph.knownPeers) {
          for (const [id, info] of Object.entries(remoteGraph.knownPeers)) {
            draft[id] = draft[id] || { displayName: info.displayName || id, neighbors: [] };
            if (Array.isArray(info.neighbors)) {
              draft[id].neighbors = Array.from(new Set([...(draft[id].neighbors || []), ...info.neighbors]));
            }
          }
        }
        // ensure we mark direct connection (if fromPeerId currently connected) as neighbor of us
        if (draft[peerID]) {
          const dir = peers[fromPeerId];
          if (dir && dir.state === PeerState.connected) {
            if (!draft[peerID].neighbors.includes(fromPeerId)) draft[peerID].neighbors.push(fromPeerId);
          }
        }
      })
    );

    // after merging, re-broadcast to help propagate (gossip)
    broadcastGraphDebounced();
  };

  // Relay handling for flooding
  const handleRelay = (msg: any, fromPeerId: string) => {
    // msg: { type:'relay', id, src, dst, ttl, text, meta? }
    if (!msg || !msg.id) return;

    const seen = seenMessageIdsRef.current;
    if (seen.has(msg.id)) return; // already processed
    seen.add(msg.id);

    // If destination is me -> deliver
    if (msg.dst === peerID) {
      pushReceived(msg.src || fromPeerId, `[delivered via ${fromPeerId}] ${msg.text}`);
      return;
    }

    // If TTL expired -> drop
    if (typeof msg.ttl !== 'number' || msg.ttl <= 0) {
      return;
    }

    // Otherwise decrement TTL and forward to all connected neighbors except fromPeerId
    const forward = { ...msg, ttl: msg.ttl - 1 };

    Object.entries(peers).forEach(([id, info]) => {
      if (info.state === PeerState.connected && id !== fromPeerId) {
        try {
          session?.sendText(id, JSON.stringify(forward));
        } catch (e) {
          // ignore
        }
      }
    });
  };

  // send multi-hop message via flood
  const sendMultiHop = (targetId: string, text: string) => {
    if (!session || !peerID) {
      Alert.alert('Not ready', 'Session not initialized');
      return;
    }
    if (!targetId) {
      Alert.alert('Choose a target peer ID');
      return;
    }
    const msgId = generateID();
    const msg = {
      type: 'relay',
      id: msgId,
      src: peerID,
      dst: targetId,
      ttl: DEFAULT_TTL,
      text,
    };

    // mark as seen locally to avoid handling our own forwarded copy
    seenMessageIdsRef.current.add(msgId);

    // send to all connected peers (flood origin)
    Object.entries(peers).forEach(([id, info]) => {
      if (info.state === PeerState.connected) {
        try {
          session.sendText(id, JSON.stringify(msg));
        } catch (e) {
          // ignore
        }
      }
    });

    // also add to our local messages as "sent"
    pushReceived(targetId, `(sent, flood) ${text}`);
  };

  // expose a convenience direct-send (existing behavior) - sends plain text directly to connected peer
  const sendDirect = (targetId: string, text: string) => {
    if (!session) return;
    try {
      session.sendText(targetId, text);
      pushReceived(targetId, `(direct to ${targetId}) ${text}`);
    } catch (e) {
      Alert.alert('Send failed', String(e));
    }
  };

  // small periodic graph broadcast to help converge (lightweight)
  useEffect(() => {
    const t = setInterval(() => {
      broadcastGraph();
    }, 5000);
    return () => clearInterval(t);
  }, [session, knownGraph, peers]);

  // UI state for multi-hop sending
  const [mhTarget, setMhTarget] = useState('');
  const [mhText, setMhText] = useState('');

  // UI state for direct sending per-peer (map peerId -> text)
  const directTextRef = useRef<Record<string, string>>({});

  // Render
  if (!displayName || !persistentID) {
    return (
      <View style={styles.container}>
        <Text style={{ fontSize: 20, marginBottom: 8 }}>Enter your display name:</Text>
        <TextInput
          style={{ fontSize: 20, borderWidth: 1, padding: 10, width: 320 }}
          placeholder="display name"
          onSubmitEditing={async (ev) => {
            const name = ev.nativeEvent.text.trim();
            if (!name) return;
            setDisplayName(name);
          }}
        />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={{ fontSize: 16, marginBottom: 6 }}>You: {displayName}</Text>
      <Text style={{ fontSize: 12, marginBottom: 12 }}>persistentID: {persistentID}</Text>

      <View style={{ marginVertical: 12 }}>
        <View style={styles.toggleRow}>
          <Text>Browsing</Text>
          <Switch
            value={isBrowsing}
            onValueChange={(v) => {
              setIsBrowsing(v);
              v ? session?.browse() : session?.stopBrowsing();
            }}
          />
        </View>
        <View style={styles.toggleRow}>
          <Text>Advertising</Text>
          <Switch
            value={isAdvertising}
            onValueChange={(v) => {
              setIsAdvertising(v);
              v ? session?.advertize() : session?.stopAdvertizing();
            }}
          />
        </View>
      </View>

      <Button
        title="Disconnect"
        onPress={() => {
          session?.disconnect();
          setPeers({});
          // clear neighbor list for us
          setKnownGraph((g) =>
            produce(g, (draft) => {
              if (draft[peerID]) draft[peerID].neighbors = [];
            })
          );
        }}
      />

      <View style={{ marginTop: 18, width: '92%' }}>
        <Text style={{ fontWeight: '700' }}>Found peers (direct)</Text>
        {Object.entries(peers).length === 0 && <Text style={{ fontStyle: 'italic' }}>none</Text>}
        {Object.entries(peers).map(([id, info]) => (
          <View key={id} style={styles.peerBox}>
            <Pressable
              onPress={() => {
                if (info.state !== PeerState.connected) session?.invite(id);
              }}
            >
              <Text style={{ fontWeight: '600' }}>{info.peer.displayName || id}</Text>
              <Text style={{ fontSize: 12, color: '#444' }}>{id} - {info.state}</Text>
              <Text style={{ fontSize: 12 }}>persistentID: {info.discoveryInfo?.myPersistentID}</Text>
            </Pressable>

            {info.state === PeerState.connected && (
              <View style={{ marginTop: 6 }}>
                <TextInput
                  style={{ borderWidth: 1, marginTop: 5, padding: 8 }}
                  placeholder="direct message to this peer"
                  onChangeText={(t) => (directTextRef.current[id] = t)}
                  defaultValue={directTextRef.current[id] || ''}
                />
                <Button title="Send direct" onPress={() => {
                  const t = directTextRef.current[id] || '';
                  if (!t.trim()) return;
                  sendDirect(id, t.trim());
                  directTextRef.current[id] = '';
                }} />
              </View>
            )}

            {receivedMessages[id] && (
              <View style={{ marginTop: 10 }}>
                <Text style={{ fontWeight: '600' }}>Received from {id}:</Text>
                {receivedMessages[id].map((msg, idx) => (
                  <Text key={idx}>{msg}</Text>
                ))}
              </View>
            )}
          </View>
        ))}
      </View>

      <View style={{ marginTop: 18, width: '92%' }}>
        <Text style={{ fontWeight: '700' }}>Known peers (gossiped graph)</Text>
        {Object.keys(knownGraph).length === 0 && <Text style={{ fontStyle: 'italic' }}>none</Text>}
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
        <Text style={{ fontSize: 12, marginBottom: 6 }}>Target: {mhTarget || '(choose from Known peers above)'}</Text>
        <TextInput
          placeholder="target peer ID"
          style={{ borderWidth: 1, padding: 8, marginBottom: 6 }}
          value={mhTarget}
          onChangeText={setMhTarget}
        />
        <TextInput
          placeholder="message to send via multi-hop flood"
          style={{ borderWidth: 1, padding: 8, marginBottom: 6 }}
          value={mhText}
          onChangeText={setMhText}
        />
        <Button title="Send (multi-hop flood)" onPress={() => {
          if (!mhTarget) {
            Alert.alert('No target', 'Choose a target peer ID first.');
            return;
          }
          if (!mhText.trim()) return;
          sendMultiHop(mhTarget.trim(), mhText.trim());
          setMhText('');
        }} />
      </View>

      <View style={{ marginTop: 18, width: '92%', marginBottom: 60 }}>
        <Text style={{ fontWeight: '700' }}>Messages stored</Text>
        {Object.keys(receivedMessages).length === 0 && <Text style={{ fontStyle: 'italic' }}>none</Text>}
        {Object.entries(receivedMessages).map(([from, arr]) => (
          <View key={from} style={{ marginTop: 8 }}>
            <Text style={{ fontWeight: '700' }}>{from}</Text>
            {arr.map((m, i) => (
              <Text key={i} style={{ paddingLeft: 8 }}>{m}</Text>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingTop: 80,
    alignItems: 'center',
    justifyContent: 'flex-start',
    backgroundColor: 'white',
    paddingBottom: 80,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: 200,
    marginVertical: 10,
  },
  peerBox: { borderWidth: 1, padding: 8, marginVertical: 10, width: '100%' },
});
