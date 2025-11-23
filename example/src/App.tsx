import * as React from 'react';
import { useState, useEffect } from 'react';
import {
  Button,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  Switch,
  Alert,
  Keyboard,
  TouchableWithoutFeedback,
  Clipboard
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  initSession,
  PeerState,
  RNPeer,
} from 'react-native-multipeer-connectivity';
import { produce } from 'immer';
import DocumentPicker from 'react-native-document-picker';
import RNFS from 'react-native-fs';
import Share from 'react-native-share';

/**
 * Merged file:
 * - Original current app logic (DM / BR / routing)
 * - File transfer logic (FILE_START / FILE_CHUNK / FILE_END)
 * - JSON-file-packet interception happens BEFORE existing routing
 * - "File" button added next to DM input for each connected peer
 *
 * Note: this keeps your existing naming and API calls (e.g. stopAdvertizing)
 * so it should slot into your environment without signature changes.
 */

/* Message signals for file transfer */
const MessageSignal = {
  FILE_START: 'FILE_START',
  FILE_CHUNK: 'FILE_CHUNK',
  FILE_END: 'FILE_END',
};

export default function App() {
  const [displayName, setDisplayName] = useState('');
  const [persistentID, setPersistentID] = useState('');
  const [peerID, setPeerID] = useState('');
  const [broadcastMessage, setBroadcastMessage] = useState('');
  const [isBrowsing, setIsBrowsing] = useState(false);
  const [isAdvertising, setIsAdvertising] = useState(false);
  const [routeID, setRouteID] = useState('');
  const [routeMessage, setRouteMessage] = useState('');

  // Keep a ref to receivedMessages for dedupe checks inside event handlers
  const [receivedMessages, setReceivedMessages] = useState<Record<string, string[]>>(
    {}
  );
  const receivedMessagesRef = React.useRef(receivedMessages);
  useEffect(() => {
    receivedMessagesRef.current = receivedMessages;
  }, [receivedMessages]);

  // Peers
  const [peers, setPeers] = useState<
    Record<
      string,
      { state: PeerState; peer: RNPeer; discoveryInfo?: Record<string, string> }
    >
  >({});
  const peersRef = React.useRef(peers);
  useEffect(() => {
    peersRef.current = peers;
  }, [peers]);

  // File transfer state
  const [fileTransfers, setFileTransfers] = useState<Record<string, {
    fileName: string;
    fileExtension: string;
    totalChunks: number;
    chunks: (string | undefined)[];
    receivedChunks: number;
  }>>({});
  const [sendingProgress, setSendingProgress] = useState<Record<string, {
    current: number;
    total: number;
    fileName: string;
  }>>({});

  const [session, setSession] = useState<null | ReturnType<typeof initSession>>(
    null
  );

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

  // Chunking utility
  const chunkBase64 = (base64String: string, chunkSize = 4000) => {
    const chunks: string[] = [];
    for (let i = 0; i < base64String.length; i += chunkSize) {
      chunks.push(base64String.slice(i, i + chunkSize));
    }
    return chunks;
  };

  // Stitch and save utility
  const stitchBase64 = async (chunks: (string | undefined)[], fileExtension: string, fileName?: string) => {
    try {
      if (!chunks || chunks.length === 0) return;

      // Ensure no undefined values
      const safeChunks = chunks.map((c) => c || '');
      const base64String = safeChunks.join('');

      const destPath = RNFS.DocumentDirectoryPath;
      const finalFileName = fileName || `received_file_${Date.now()}.${fileExtension}`;
      const filePath = `${destPath}/${finalFileName}`;

      await RNFS.writeFile(filePath, base64String, 'base64');

      // Trigger share/save
      await Share.open({
        url: `file://${filePath}`,
        type: 'application/octet-stream',
        title: finalFileName,
      });

      return filePath;
    } catch (err) {
      console.warn('Failed to save or share file:', err);
    }
  };

  // Send picked file to a specific peer (targetPeerId)
  const pickAndSendFile = async (targetPeerId: string) => {
    try {
      const res = await DocumentPicker.pickSingle({
        type: [DocumentPicker.types.allFiles],
      });

      // Normalize uri
      let filePath = res.uri;
      if (filePath.startsWith('file://')) filePath = filePath.slice(7);

      const base64 = await RNFS.readFile(filePath, 'base64');
      const chunks = chunkBase64(base64, 4000);

      const fileExtension = res.name?.split('.').pop() || 'dat';
      const fileId = generateID();

      // Send FILE_START
      const startPacket = {
        signal: MessageSignal.FILE_START,
        fileId,
        fileName: res.name,
        fileExtension,
        totalChunks: chunks.length,
      };
      session?.sendText(targetPeerId, JSON.stringify(startPacket));

      // Initialize progress
      setSendingProgress((prev) => ({
        ...prev,
        [fileId]: { current: 0, total: chunks.length, fileName: res.name },
      }));

      // Send each chunk with a small delay to avoid saturating the channel
      for (let i = 0; i < chunks.length; i++) {
        // small throttle
        await new Promise((r) => setTimeout(r, 50));

        const chunkPacket = {
          signal: MessageSignal.FILE_CHUNK,
          fileId,
          chunkIndex: i,
          totalChunks: chunks.length,
          chunk: chunks[i],
        };
        session?.sendText(targetPeerId, JSON.stringify(chunkPacket));

        setSendingProgress((prev) => ({
          ...prev,
          [fileId]: { ...prev[fileId], current: i + 1 },
        }));
      }

      // Send FILE_END
      const endPacket = {
        signal: MessageSignal.FILE_END,
        fileId,
      };
      session?.sendText(targetPeerId, JSON.stringify(endPacket));

      // Clear sending progress after a short delay
      setTimeout(() => {
        setSendingProgress((prev) => {
          const next = { ...prev };
          delete next[fileId];
          return next;
        });
      }, 3000);
    } catch (err: any) {
      if (!DocumentPicker.isCancel(err)) {
        console.warn('Error picking/sending file:', err);
        Alert.alert('File Error', String(err?.message || err));
      }
    }
  };

  // Setup session event handlers (including JSON interception for file packets)
  useEffect(() => {
    if (!session) return;

    const r1 = session.onStartAdvertisingError(() => setIsAdvertising(false));
    const r2 = session.onStartBrowsingError(() => setIsBrowsing(false));

    const r3 = session.onFoundPeer((ev: any) => {
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

    const r4 = session.onLostPeer((ev: any) => {
      setPeers(
        produce((draft) => {
          delete draft[ev.peer.id];
        })
      );
    });

    const r5 = session.onPeerStateChanged((ev: any) => {
      setPeers(
        produce((draft) => {
          if (draft[ev.peer.id]) draft[ev.peer.id].state = ev.state;
          else draft[ev.peer.id] = { peer: ev.peer, state: ev.state };
        })
      );

      // Retry invitation if not connected (limited retries)
      if (ev.state !== PeerState.connected) {
        const retryInvite = (attempts = 0) => {
          if (
            session &&
            peersRef.current[ev.peer.id]?.state !== PeerState.connected &&
            attempts < 10
          ) {
            session.invite(ev.peer.id);
            setTimeout(() => retryInvite(attempts + 1), 1000);
          }
        };
        retryInvite();
      }
    });

    const r6 = session.onReceivedPeerInvitation((ev: any) => ev.handler(true));

    // Received text handler: intercept JSON-file-packets first, otherwise fall back to existing routing
    const r7 = session.onReceivedText((ev: any) => {
      const raw = ev.text;

      // Try parse JSON - this will catch our file packets
      let parsed: any = null;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        parsed = null;
      }

      // If parsed and has a signal that we recognize as file-related, handle and exit early
      if (parsed && parsed.signal) {
        if (parsed.signal === MessageSignal.FILE_START) {
          const { fileId, fileName, fileExtension, totalChunks } = parsed;
          setFileTransfers((prev) => ({
            ...prev,
            [fileId]: {
              fileName,
              fileExtension,
              totalChunks,
              chunks: new Array(totalChunks),
              receivedChunks: 0,
            },
          }));
          return;
        }

        if (parsed.signal === MessageSignal.FILE_CHUNK) {
          const { fileId, chunkIndex, chunk } = parsed;

          setFileTransfers((prev) => {
            const transfer = prev[fileId];
            if (!transfer) return prev;

            const newChunks = [...transfer.chunks];
            newChunks[chunkIndex] = chunk;

            return {
              ...prev,
              [fileId]: {
                ...transfer,
                chunks: newChunks,
                receivedChunks: transfer.receivedChunks + 1,
              },
            };
          });
          return;
        }

        if (parsed.signal === MessageSignal.FILE_END) {
          const { fileId } = parsed;

          setFileTransfers((prev) => {
            const transfer = prev[fileId];
            if (!transfer) return prev;

            // Reconstruct and save/share
            stitchBase64(transfer.chunks, transfer.fileExtension, transfer.fileName);

            // Clean up after a short delay
            setTimeout(() => {
              setFileTransfers((cur) => {
                const next = { ...cur };
                delete next[fileId];
                return next;
              });
            }, 2000);

            return prev;
          });
          return;
        }
      }

      // If not a JSON-file packet, proceed with the existing message handling logic
      let msg = raw;

      // DEDUPE and normal routing behavior
      if (msg.startsWith('[DM]')) {
        const alreadyHave = receivedMessagesRef.current[ev.peer.id]?.includes(msg);

        if (!alreadyHave) {
          setReceivedMessages(
            produce((draft) => {
              (draft[ev.peer.id] ||= []).push(msg);
            })
          );
        }
      } else if (msg.startsWith('[BR]')) {
        // DEDUPE
        const alreadyHave = receivedMessagesRef.current[ev.peer.id]?.includes(msg);
        if (!alreadyHave) {
          setReceivedMessages(
            produce((draft) => {
              (draft[ev.peer.id] ||= []).push(msg);
            })
          );
        }

        // FORWARD to others
        Object.keys(peersRef.current).forEach((id) => {
          const p = peersRef.current[id];
          if (id !== ev.peer.id && p.state === PeerState.connected) {
            session?.sendText(id, msg);
          }
        });

      } else {
        // Expect a manual-routed message like "[<id>] message"
        const found = msg.match(/\[(.*?)\]/);
        const result = found ? found[1] : null;
        if (result === peerID) {
          const alreadyHave = receivedMessagesRef.current[ev.peer.id]?.includes(msg);

          if (!alreadyHave) {
            setReceivedMessages(
              produce((draft) => {
                (draft[ev.peer.id] ||= []).push(msg);
              })
            );
          }
        } else {
          Object.keys(peersRef.current).forEach((id) => {
            const p = peersRef.current[id];
            if (id !== ev.peer.id && p.state === PeerState.connected) {
              session?.sendText(id, msg);
            }
          });
        }
      }
    });

    return () => {
      // keep the same stop method names you use elsewhere
      try {
        session.stopAdvertizing();
      } catch { }
      try {
        session.stopBrowsing();
      } catch { }
      r1.remove();
      r2.remove();
      r3.remove();
      r4.remove();
      r5.remove();
      r6.remove();
      r7.remove();
    };
  }, [session, peerID]);

  // Initial displayName step: create session on submit
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

  // UI render
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

        {/* Optional: Sending progress UI */}
        {Object.keys(sendingProgress).length > 0 && (
          <View style={{ marginTop: 20, width: '90%' }}>
            <Text>Sending Files:</Text>
            {Object.entries(sendingProgress).map(([fid, p]) => (
              <View key={fid} style={{ marginTop: 6 }}>
                <Text style={{ fontSize: 12 }}>{p.fileName}</Text>
                <Text style={{ fontSize: 12 }}>{p.current} / {p.total}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Optional: Receiving progress UI */}
        {Object.keys(fileTransfers).length > 0 && (
          <View style={{ marginTop: 20, width: '90%' }}>
            <Text>Receiving Files:</Text>
            {Object.entries(fileTransfers).map(([fid, t]) => (
              <View key={fid} style={{ marginTop: 6 }}>
                <Text style={{ fontSize: 12 }}>{t.fileName}</Text>
                <Text style={{ fontSize: 12 }}>{t.receivedChunks} / {t.totalChunks}</Text>
              </View>
            ))}
          </View>
        )}

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

              const formattedMsg = '[BR] ' + msg;

              Object.keys(peers).forEach((id) => {
                if (peers[id].state === PeerState.connected) {
                  session?.sendText(id, formattedMsg);
                }
              });

              setBroadcastMessage('');
            }}
          />
        </View>

        {/* Manual route message */}
        <View style={{ marginTop: 20, width: '90%' }}>
          <Text>Send message with manual ID:</Text>

          <TextInput
            style={{ borderWidth: 1, padding: 5, marginTop: 5 }}
            placeholder="Enter ID"
            value={routeID}
            onChangeText={setRouteID}
          />

          <TextInput
            style={{ borderWidth: 1, padding: 5, marginTop: 5 }}
            placeholder="Enter message"
            value={routeMessage}
            onChangeText={setRouteMessage}
            onSubmitEditing={() => {
              const idt = routeID.trim();
              const msg = routeMessage.trim();

              if (!idt || !msg) return;

              const formattedMsg = `[${idt}] ${msg}`;

              // send to ALL connected peers
              Object.keys(peers).forEach((id) => {
                if (peers[id].state === PeerState.connected && id !== idt) {
                  session?.sendText(id, formattedMsg);
                  setReceivedMessages(
                    produce((draft) => {
                      (draft[id] ||= []).push(formattedMsg);
                    })
                  );
                }
              });

              setRouteMessage('');
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
                <Pressable
                  onPress={() => {
                    Clipboard.setString(id);
                    Alert.alert('Copied', `Peer ID "${id}" copied to clipboard`);
                  }}
                >
                  <Text style={{ color: 'blue', textDecorationLine: 'underline' }}>
                    {id} - {info.state}
                  </Text>
                </Pressable>
                <Text>displayName: {info.peer.displayName}</Text>
                <Text>persistentID: {info.discoveryInfo?.myPersistentID}</Text>
              </Pressable>

              {info.state === PeerState.connected && (
                <>
                  {/* File button */}
                  <View style={{ marginTop: 8, marginBottom: 6 }}>
                    <Button
                      title="File"
                      onPress={() => pickAndSendFile(id)}
                    />
                  </View>

                  <TextInput
                    style={{ borderWidth: 1, marginTop: 5, padding: 6 }}
                    placeholder="send a message"
                    onSubmitEditing={(ev) => {
                      if (ev.nativeEvent.text.trim())
                        session?.sendText(id, '[DM] ' + ev.nativeEvent.text);
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
