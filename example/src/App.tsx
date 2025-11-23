import * as React from 'react';
import { useState } from 'react';
import {
  Button,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  Switch,
} from 'react-native';
import {
  initSession,
  PeerState,
  RNPeer,
} from 'react-native-multipeer-connectivity';
import { produce } from 'immer';

export default function App() {
  const [displayName, setDisplayName] = useState('');
  const [peerID, setPeerID] = useState('');
  const [isBrowsing, setIsBrowsing] = useState(false);
  const [isAdvertising, setIsAdvertising] = useState(false);

  const [peers, setPeers] = React.useState<
    Record<
      string,
      { state: PeerState; peer: RNPeer; discoveryInfo?: Record<string, string> }
    >
  >({});
  const [receivedMessages, setReceivedMessages] = React.useState<
    Record<string, string[]>
  >({});

  const [session, setSession] = useState<null | ReturnType<typeof initSession>>(
    null
  );

  React.useEffect(() => {
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
          if (draft[ev.peer.id]) {
            draft[ev.peer.id].state = ev.state;
          } else {
            draft[ev.peer.id] = {
              peer: ev.peer,
              state: ev.state,
            };
          }
        })
      );
    });

    const r6 = session.onReceivedPeerInvitation((ev) => ev.handler(true));

    const r7 = session.onReceivedText((ev) => {
      setReceivedMessages(
        produce((draft) => {
          (draft[ev.peer.id] ||= []).push(ev.text);
        })
      );
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

  if (!displayName) {
    return (
      <View style={styles.container}>
        <Text style={{ fontSize: 20, marginBottom: 5 }}>
          Input your display name and enter:
        </Text>
        <TextInput
          style={{
            fontSize: 30,
            borderWidth: 1,
            padding: 10,
            width: 300,
          }}
          placeholder={'display name'}
          onSubmitEditing={(ev) => {
            const name = ev.nativeEvent.text;
            setDisplayName(name);

            const s = initSession({
              displayName: name,
              serviceType: 'demo',
              discoveryInfo: {
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
    <View style={styles.container}>
      <Text>my id: {peerID}</Text>

      <View style={{ marginVertical: 20 }}>
        <View style={styles.toggleRow}>
          <Text>Browsing</Text>
          <Switch
            value={isBrowsing}
            onValueChange={(v) => {
              setIsBrowsing(v);
              if (v) session?.browse();
              else session?.stopBrowsing();
            }}
          />
        </View>

        <View style={styles.toggleRow}>
          <Text>Advertising</Text>
          <Switch
            value={isAdvertising}
            onValueChange={(v) => {
              setIsAdvertising(v);
              if (v) session?.advertize();
              else session?.stopAdvertizing();
            }}
          />
        </View>
      </View>

      <Button
        title={'disconnect'}
        onPress={() => {
          session?.disconnect();
          setPeers({});
        }}
      />

      <View style={{ marginTop: 30, width: '90%' }}>
        <Text>Found peers:</Text>

        {Object.entries(peers).map(([id, info]) => (
          <View key={id} style={styles.peerBox}>
            <Pressable
              onPress={() => {
                if (info.state !== PeerState.connected) {
                  session?.invite(id);
                }
              }}
            >
              <Text>
                {id} - {info.state}
              </Text>
              <Text>displayName: {info.peer.displayName}</Text>
            </Pressable>

            {info.state === PeerState.connected && (
              <View>
                <TextInput
                  style={{ borderWidth: 1, marginTop: 5 }}
                  placeholder="send a message"
                  onSubmitEditing={(ev) => {
                    const text = ev.nativeEvent.text;
                    if (text.trim().length > 0) {
                      session?.sendText(id, text);
                    }
                  }}
                />
              </View>
            )}

            {receivedMessages[id] && (
              <View style={{ marginTop: 10 }}>
                <Text>Received messages:</Text>
                {receivedMessages[id].map((msg, idx) => (
                  <Text key={idx}>{msg}</Text>
                ))}
              </View>
            )}
          </View>
        ))}
      </View>
    </View>
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
  peerBox: {
    borderWidth: 1,
    padding: 8,
    marginVertical: 10,
  },
});
