import * as React from 'react';
import { useState, useEffect } from 'react';
import {
  Button,
  Pressable,
  StyleSheet,
  Text,
  ScrollView,
  TextInput,
  View,
  Switch,
  Keyboard,
  TouchableWithoutFeedback
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  initSession,
  PeerState,
  RNPeer,
} from 'react-native-multipeer-connectivity';
import { produce } from 'immer';
import { Alert } from 'react-native';


export default function App() {
  const [displayName, setDisplayName] = useState('');
  const [persistentID, setPersistentID] = useState('');
  const [peerID, setPeerID] = useState('');
  const [broadcastMessage, setBroadcastMessage] = useState('');
  const [relayTargetId, setRelayTargetId] = useState('');
  const [relayMessage, setRelayMessage] = useState('');
  const [isBrowsing, setIsBrowsing] = useState(false);
  const [isAdvertising, setIsAdvertising] = useState(false);
  const [devLogs, setDevLogs] = useState([]);
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

  const addLog = (msg) => setDevLogs(l => [...l, msg]);

  const sendMessage = (msg, isBroadcast, targetId = null, skip = null) => {
    if (!msg || !session) return;

    const text = isBroadcast ? `[BR] ${msg}` : msg;
    addLog(`sendMessage: ${text}`);

    // Broadcast
    if (isBroadcast) {
      Object.keys(peers).forEach((id) => {
        if (peers[id].state === PeerState.connected) {
          session.sendText(id, text);

          setReceivedMessages((draft) => {
            (draft[id] ||= []).push(text);
            return draft;
          });
        }
      });
      return;
    }

    // Apply skip logic only to direct messages
    if (skip && targetId === skip) {
      addLog(`sendMessage skipped direct message to ${targetId}`);
      return;
    }

    // Direct message
    if (!targetId) {
      addLog("sendMessage error: Missing targetId for direct message");
      return;
    }

    session.sendText(targetId, text);

    setReceivedMessages((draft) => {
      (draft[targetId] ||= []).push(text);
      return draft;
    });
  };


  // Simple pseudo-unique ID generator
  const generateID = () =>
    Date.now().toString(36) + Math.random().toString(36).substring(2, 10);

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

  const peersRef = React.useRef(peers);

  useEffect(() => {
    peersRef.current = peers;
  }, [peers]);

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
            // Immediately invite the peer
            session?.invite(ev.peer.id);
          }
        })
      );
    });

    const r4 = session.onLostPeer((ev) => {
      setPeers(
        produce((draft) => {
          delete draft[ev.peer.id];
        })
      );
    });
    const r5 = session.onPeerStateChanged((ev) => {
      setPeers(
        produce((draft) => {
          if (draft[ev.peer.id]) draft[ev.peer.id].state = ev.state;
          else draft[ev.peer.id] = { peer: ev.peer, state: ev.state };
        })
      );

      // Retry invitation if not connected
      if (ev.state !== PeerState.connected) {
        const retryInvite = (attempts = 0) => {
          if (
            session &&
            peers[ev.peer.id]?.state !== PeerState.connected &&
            attempts < 10 // limit retries to 10
          ) {
            session.invite(ev.peer.id);
            setTimeout(() => retryInvite(attempts + 1), 1000); // retry after 1s
          }
        };
        retryInvite();
      }
    });


    const r6 = session.onReceivedPeerInvitation((ev) => ev.handler(true));
    const r7 = session.onReceivedText((ev) => {
      let msg = ev.text;

      addLog(ev.text);
      addLog(ev.peer.id);
      addLog("==========")

      setReceivedMessages(
        produce((draft) => {
          (draft[ev.peer.id] ||= []).push(msg);
        })
      );

      // Relay broadcast messages
      if (msg.startsWith('[BR]')) {
        // strip the broadcast prefix before re-sending
        const clean = msg.replace(/^\[BR\]\s?/, '');
        sendMessage(clean, true);
      }
    });

    return () => {
      session.stopAdvertizing();
      session.stopBrowsing();
      r1.remove();
      r2.remove();
      r3.remove();
      r4.remove();
      r5.remove();
      r6.remove();
      r7.remove();
    };
  }, [session]);

  if (!displayName || !persistentID) {
    return (
      <View style={styles.container}>
        <Text style={{ fontSize: 20, marginBottom: 5 }}>
          Enter your display name:
        </Text>
        <TextInput
          style={{ fontSize: 30, borderWidth: 1, padding: 10, width: 300 }}
          placeholder="display name"
          onSubmitEditing={async (ev) => {
            const name = ev.nativeEvent.text;
            setDisplayName(name);

            const s = initSession({
              displayName: name,
              serviceType: 'demo',
              discoveryInfo: {
                myPersistentID: persistentID,
                myName: name,
                joinAt: Date.now().toString(),
              },
            });

            setSession(s);
            setPeerID(s.peerID);
          }}
        />
      </View>
    );
  }

  return (
  <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
    <View style={styles.container}>
      <Text style={{ fontSize: 16, marginBottom: 10 }}>
        my persistent ID: {persistentID}
      </Text>

      <View style={{ marginVertical: 20 }}>
        <View style={styles.toggleRow}>
          <Text>Set Available</Text>
          <Switch
            value={isBrowsing}
            onValueChange={(v) => {
              addLog("switch pressed");
              setIsBrowsing(v);
              v ? session?.browse() : session?.stopBrowsing();
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
        }}
      />

      {/* Broadcast section */}
      <View style={{ marginTop: 20, width: '90%' }}>
        <Text>Broadcast message to all peers:</Text>
        <TextInput
          style={{ borderWidth: 1, padding: 5, marginTop: 5 }}
          placeholder="Enter broadcast message"
          value={broadcastMessage}
          onChangeText={setBroadcastMessage}
          onSubmitEditing={() => {
            const msg = broadcastMessage.trim();
            if (!msg) return;

            const formattedMsg = "[BR] " + msg;

            Object.keys(peers).forEach((id) => {
              if (peers[id].state === PeerState.connected) {
                sendMessage(formattedMsg, true);
                // Add the sent message to local state so it displays
                setReceivedMessages(
                  produce((draft) => {
                    (draft[id] ||= []).push(formattedMsg);
                  })
                );
              }
            });

            setBroadcastMessage('');
          }}
        />
      </View>

      {/* Found peers list */}
      <View style={{ marginTop: 30, width: '90%' }}>
        <Text>Found peers:</Text>
        {Object.entries(peers).map(([id, info]) => (
          <View key={id} style={styles.peerBox}>
            <Pressable
              onPress={() => {
                if (info.state !== PeerState.connected) session?.invite(id);
              }}
            >
              <Text>
                {id} - {info.state}
              </Text>
              <Text>displayName: {info.peer.displayName}</Text>
              <Text>persistentID: {info.discoveryInfo?.myPersistentID}</Text>
            </Pressable>

            {info.state === PeerState.connected && (
              <>
                <TextInput
                  style={{ borderWidth: 1, marginTop: 5 }}
                  placeholder="send a message"
                  onSubmitEditing={(ev) => {
                    const msg = ev.nativeEvent.text.trim();
                    if (msg) sendMessage(msg, false, id);
                  }}
                />


                <View style={{ marginTop: 10 }}>
                  <Text>Message History:</Text>
                  {receivedMessages[id] && receivedMessages[id].map((msg, idx) => (
                    <Text key={idx}>{msg}</Text>
                  ))}
                </View>
              </>
            )}
          </View>
        ))}
      </View>

      {/* Relay message section */}
      <View style={{ marginTop: 30, width: '90%' }}>
        <Text>Send message through neighbors:</Text>
        
        <TextInput
          style={{ borderWidth: 1, marginTop: 5, padding: 5 }}
          placeholder="Enter target peer ID"
          value={relayTargetId}
          onChangeText={setRelayTargetId}
        />

        <TextInput
          style={{ borderWidth: 1, marginTop: 5, padding: 5 }}
          placeholder="Enter message"
          value={relayMessage}
          onChangeText={setRelayMessage}
          onSubmitEditing={() => {
            const msg = relayMessage.trim();
            if (!msg || !relayTargetId) return;

            // Send message to all neighbors except target
            Object.keys(peers).forEach((id) => {
              if (peers[id].state === PeerState.connected) {
                sendMessage(msg, false, id, relayTargetId);
              }
            });

            addLog(`Relay message sent to neighbors for target ${relayTargetId}`);
            setRelayMessage('');
          }}
        />
      </View>


      {/* DEBUG VIEW */}
      <ScrollView>
        {devLogs.map((l, i) => (
          <Text key={i}>{l}</Text>
        ))}
      </ScrollView>
     </View>
    </TouchableWithoutFeedback>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingTop: 80,
    backgroundColor: 'white',
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: 200,
    marginVertical: 10,
  },
  peerBox: { borderWidth: 1, padding: 8, marginVertical: 10 },
});
