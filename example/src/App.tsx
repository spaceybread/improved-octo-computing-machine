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
import RNFS from 'react-native-fs';
import DocumentPicker from 'react-native-document-picker';
import Share from 'react-native-share';

// Message Protocol
const MessageSignal = {
  BROADCAST: 'BROADCAST',
  NEIGHBOR: 'NEIGHBOR',
  DISTANT: 'DISTANT',
  FILE_CHUNK: 'FILE_CHUNK',
  FILE_START: 'FILE_START',
  FILE_END: 'FILE_END'
};

export default function App() {
  const [displayName, setDisplayName] = useState('');
  const [persistentID, setPersistentID] = useState('');
  const [peerID, setPeerID] = useState('');
  const [isBrowsing, setIsBrowsing] = useState(false);
  const [isAdvertising, setIsAdvertising] = useState(false);
  const [devLogs, setDevLogs] = useState([]);
  const [peers, setPeers] = useState({});
  const [receivedMessages, setReceivedMessages] = useState({});
  const [session, setSession] = useState(null);

  // UI State
  const [broadcastInput, setBroadcastInput] = useState('');
  const [distantRecipient, setDistantRecipient] = useState('');
  const [distantMessageInput, setDistantMessageInput] = useState('');

  // File transfer state
  const [fileTransfers, setFileTransfers] = useState({});
  const [sendingProgress, setSendingProgress] = useState({});

  const addLog = (msg) => {
    console.log(msg);
    setDevLogs(l => [...l, `${new Date().toLocaleTimeString()}: ${msg}`]);
  };

  const serializeMessage = (msg) => JSON.stringify(msg);
  const deserializeMessage = (text) => {
    try {
      return JSON.parse(text);
    } catch (e) {
      addLog(`Failed to parse: ${text}`);
      return null;
    }
  };

  const sendMessage = (message, targetPeerId) => {
    if (!session) return;
    const serialized = serializeMessage(message);
    
    if (targetPeerId) {
      addLog(`Sending ${message.signal} to ${targetPeerId}`);
      session.sendText(targetPeerId, serialized);
    } else {
      Object.keys(peers).forEach((id) => {
        if (peers[id].state === PeerState.connected) {
          addLog(`Sending ${message.signal} to ${id}`);
          session.sendText(id, serialized);
        }
      });
    }
  };

  const chunkBase64 = (base64String, chunkSize = 4000) => {
    const chunks = [];
    for (let i = 0; i < base64String.length; i += chunkSize) {
      chunks.push(base64String.slice(i, i + chunkSize));
    }
    return chunks;
  };

  const stitchBase64 = async (chunks, fileExtension, fileName) => {
    if (!chunks || chunks.length === 0) return;

    const base64String = chunks.join("");

    try {
      const destPath = RNFS.DocumentDirectoryPath;
      const finalFileName = fileName || `received_file_${Date.now()}.${fileExtension}`;
      const filePath = `${destPath}/${finalFileName}`;

      await RNFS.writeFile(filePath, base64String, "base64");

      addLog(`File reconstructed and saved at: ${filePath}`);

      await Share.open({
        url: `file://${filePath}`,
        type: 'application/octet-stream',
        title: `Save ${finalFileName}`,
      });
  
      return filePath;
    } catch (err) {
      addLog(`Failed to save file: ${err}`);
    }
  };

  const pickAndSendFile = async (targetPeerId) => {
    try {
      const res = await DocumentPicker.pickSingle({
        type: [DocumentPicker.types.allFiles],
      });

      let filePath = res.uri;
      if (filePath.startsWith("file://")) filePath = filePath.slice(7);

      const base64 = await RNFS.readFile(filePath, "base64");
      const chunks = chunkBase64(base64, 4000);
      
      // Extract file extension
      const fileExtension = res.name.split('.').pop() || 'dat';
      const fileId = generateID();

      addLog(`Sending file: ${res.name} (${chunks.length} chunks)`);

      // Send FILE_START
      sendMessage({
        signal: MessageSignal.FILE_START,
        parameters: {
          sender: persistentID,
          fileId,
          fileName: res.name,
          fileExtension,
          totalChunks: chunks.length
        },
        content: `Starting file transfer: ${res.name}`,
        visited: [persistentID]
      }, targetPeerId);

      // Initialize sending progress
      setSendingProgress(prev => ({
        ...prev,
        [fileId]: { current: 0, total: chunks.length, fileName: res.name }
      }));

      // Send chunks with delay
      for (let i = 0; i < chunks.length; i++) {
        await new Promise(resolve => setTimeout(resolve, 50)); // Small delay between chunks
        
        sendMessage({
          signal: MessageSignal.FILE_CHUNK,
          parameters: {
            sender: persistentID,
            fileId,
            chunkIndex: i,
            totalChunks: chunks.length
          },
          content: chunks[i],
          visited: [persistentID]
        }, targetPeerId);

        setSendingProgress(prev => ({
          ...prev,
          [fileId]: { ...prev[fileId], current: i + 1 }
        }));
      }

      // Send FILE_END
      sendMessage({
        signal: MessageSignal.FILE_END,
        parameters: {
          sender: persistentID,
          fileId
        },
        content: `File transfer complete: ${res.name}`,
        visited: [persistentID]
      }, targetPeerId);

      addLog(`File sent successfully: ${res.name}`);
      
      // Clear progress after a delay
      setTimeout(() => {
        setSendingProgress(prev => {
          const newProgress = { ...prev };
          delete newProgress[fileId];
          return newProgress;
        });
      }, 3000);

    } catch (err) {
      if (!DocumentPicker.isCancel(err)) {
        addLog(`Error picking file: ${err}`);
      }
    }
  };

  const receiveMessage = (senderId, message) => {
    if (!message || !message.signal || !message.content) {
      addLog(`Invalid message from ${senderId}`);
      return;
    }

    if (!persistentID) return;

    if (!message.visited) message.visited = [];

    if (message.visited.includes(persistentID)) {
      addLog(`Already saw this message`);
      return;
    }

    const updatedMessage = {
      ...message,
      visited: [...message.visited, persistentID]
    };

    if (!updatedMessage.parameters) updatedMessage.parameters = {};

    // Handle file transfer messages
    if (message.signal === MessageSignal.FILE_START) {
      const { fileId, fileName, fileExtension, totalChunks } = message.parameters;
      setFileTransfers(prev => ({
        ...prev,
        [fileId]: {
          fileName,
          fileExtension,
          totalChunks,
          chunks: [],
          receivedChunks: 0
        }
      }));
      addLog(`📥 Receiving file: ${fileName} (${totalChunks} chunks)`);
      return;
    }

    if (message.signal === MessageSignal.FILE_CHUNK) {
      const { fileId, chunkIndex, totalChunks } = message.parameters;
      setFileTransfers(prev => {
        const transfer = prev[fileId];
        if (!transfer) return prev;

        const newChunks = [...transfer.chunks];
        newChunks[chunkIndex] = message.content;

        return {
          ...prev,
          [fileId]: {
            ...transfer,
            chunks: newChunks,
            receivedChunks: transfer.receivedChunks + 1
          }
        };
      });
      return;
    }

    if (message.signal === MessageSignal.FILE_END) {
      const { fileId } = message.parameters;
      setFileTransfers(prev => {
        const transfer = prev[fileId];
        if (!transfer) return prev;

        // Stitch the file
        stitchBase64(transfer.chunks, transfer.fileExtension, transfer.fileName);
        
        addLog(`✅ File received: ${transfer.fileName}`);

        // Remove from transfers after a delay
        setTimeout(() => {
          setFileTransfers(current => {
            const newTransfers = { ...current };
            delete newTransfers[fileId];
            return newTransfers;
          });
        }, 3000);

        return prev;
      });
      return;
    }

    // Regular message handling
    const displayText = `[${message.signal}] ${message.content} (from: ${message.parameters.sender || 'unknown'})`;
    setReceivedMessages(
      produce((draft) => {
        if (!draft[senderId]) draft[senderId] = [];
        draft[senderId].push(displayText);
      })
    );

    switch (message.signal) {
      case MessageSignal.BROADCAST:
        addLog(`Rebroadcasting to all neighbors except ${senderId}`);
        Object.keys(peers).forEach((id) => {
          if (peers[id].state === PeerState.connected && id !== senderId) {
            sendMessage(updatedMessage, id);
          }
        });
        break;

      case MessageSignal.NEIGHBOR:
        if (message.parameters.neighborId === persistentID) {
          addLog(`Neighbor message for me!`);
        }
        break;

      case MessageSignal.DISTANT:
        if (message.parameters.recipient === persistentID) {
          addLog(`🎯 DISTANT MESSAGE ARRIVED: ${message.content}`);
          return;
        }

        const recipientPeer = Object.entries(peers).find(
          ([id, info]) => info.discoveryInfo?.myPersistentID === message.parameters.recipient
        );

        if (recipientPeer && recipientPeer[1].state === PeerState.connected) {
          addLog(`Forwarding to neighbor ${recipientPeer[0]}`);
          sendMessage(updatedMessage, recipientPeer[0]);
        } else {
          addLog(`Propagating to all neighbors`);
          Object.entries(peers).forEach(([id, info]) => {
            if (
              info.state === PeerState.connected &&
              id !== senderId &&
              !message.visited.includes(info.discoveryInfo?.myPersistentID || '')
            ) {
              sendMessage(updatedMessage, id);
            }
          });
        }
        break;
    }
  };

  const initiateBroadcast = (content) => {
    const message = {
      signal: MessageSignal.BROADCAST,
      parameters: { sender: persistentID },
      content,
      visited: [persistentID]
    };

    addLog(`Broadcasting: ${content}`);
    sendMessage(message);
    
    Object.keys(peers).forEach((id) => {
      if (peers[id].state === PeerState.connected) {
        setReceivedMessages(
          produce((draft) => {
            if (!draft[id]) draft[id] = [];
            draft[id].push(`[BROADCAST] ${content} (from: me)`);
          })
        );
      }
    });
  };

  const sendNeighborMessage = (neighborPeerId, content) => {
    const neighborInfo = peers[neighborPeerId];
    if (!neighborInfo || neighborInfo.state !== PeerState.connected) {
      addLog(`Peer not connected`);
      return;
    }

    const message = {
      signal: MessageSignal.NEIGHBOR,
      parameters: {
        sender: persistentID,
        neighborId: neighborInfo.discoveryInfo?.myPersistentID
      },
      content,
      visited: [persistentID]
    };

    sendMessage(message, neighborPeerId);
    
    setReceivedMessages(
      produce((draft) => {
        if (!draft[neighborPeerId]) draft[neighborPeerId] = [];
        draft[neighborPeerId].push(`[NEIGHBOR] ${content} (from: me)`);
      })
    );
  };

  const sendDistantMessage = (recipientPersistentId, content) => {
    const message = {
      signal: MessageSignal.DISTANT,
      parameters: {
        sender: persistentID,
        recipient: recipientPersistentId
      },
      content,
      visited: [persistentID]
    };

    addLog(`Sending distant message to ${recipientPersistentId}`);
    
    Object.entries(peers).forEach(([id, info]) => {
      if (info.discoveryInfo?.myPersistentID === recipientPersistentId) {
        addLog(`Skipping direct recipient ${id}`);
        return;
      }
      
      if (info.state === PeerState.connected) {
        sendMessage(message, id);
      }
    });
  };

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

  useEffect(() => {
    if (!session) return;

    const r1 = session.onStartAdvertisingError(() => {
      setIsAdvertising(false);
      addLog('Advertising error');
    });

    const r2 = session.onStartBrowsingError(() => {
      setIsBrowsing(false);
      addLog('Browsing error');
    });

    const r3 = session.onFoundPeer((ev) => {
      addLog(`Found: ${ev.peer.displayName}`);
      setPeers(
        produce((draft) => {
          if (!draft[ev.peer.id]) {
            draft[ev.peer.id] = {
              peer: ev.peer,
              state: PeerState.notConnected,
              discoveryInfo: ev.discoveryInfo,
            };
            session?.invite(ev.peer.id);
          }
        })
      );
    });

    const r4 = session.onLostPeer((ev) => {
      addLog(`Lost: ${ev.peer.displayName}`);
      setPeers(
        produce((draft) => {
          delete draft[ev.peer.id];
        })
      );
    });

    const r5 = session.onPeerStateChanged((ev) => {
      addLog(`${ev.peer.displayName} state: ${ev.state}`);
      setPeers(
        produce((draft) => {
          if (draft[ev.peer.id]) {
            draft[ev.peer.id].state = ev.state;
          } else {
            draft[ev.peer.id] = { peer: ev.peer, state: ev.state };
          }
        })
      );
    });

    const r6 = session.onReceivedPeerInvitation((ev) => {
      addLog(`Invitation from: ${ev.peer.displayName}`);
      ev.handler(true);
    });

    const r7 = session.onReceivedText((ev) => {
      const message = deserializeMessage(ev.text);
      if (message) {
        receiveMessage(ev.peer.id, message);
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
  }, [session, peers, persistentID]);

  if (!displayName || !persistentID) {
    return (
      <View style={styles.container}>
        <Text style={{ fontSize: 20, marginBottom: 5 }}>
          Enter your display name:
        </Text>
        <TextInput
          style={{ fontSize: 30, borderWidth: 1, padding: 10, width: 300 }}
          placeholder="display name"
          onSubmitEditing={(ev) => {
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
            addLog(`Session created: ${s.peerID}`);
          }}
        />
      </View>
    );
  }

  return (
    <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
      <ScrollView style={styles.scrollContainer}>
        <View style={styles.container}>
          <Text style={{ fontSize: 16, marginBottom: 10 }}>
            Persistent ID: {persistentID}
          </Text>
          <Text style={{ fontSize: 12, color: 'gray' }}>
            {displayName}
          </Text>

          <View style={{ marginVertical: 20 }}>
            {isBrowsing ? (
              <Button
                title="Stop Browse & Advertise"
                onPress={() => {
                  session?.stopBrowsing();
                  session?.stopAdvertizing();
                  setIsBrowsing(false);
                  setIsAdvertising(false);
                }}
              />
            ) : (
              <Button
                title="Start Browse & Advertise"
                onPress={() => {
                  session?.browse();
                  session?.advertize();
                  setIsBrowsing(true);
                  setIsAdvertising(true);
                }}
              />
            )}
            <Text style={{ fontSize: 12, color: 'gray', marginTop: 5 }}>
              {isBrowsing ? '🟢 Active' : '🔴 Inactive'} | Peers: {Object.keys(peers).length}
            </Text>
          </View>

          <Button
            title="Disconnect All"
            onPress={() => {
              session?.disconnect();
              setPeers({});
            }}
          />

          {/* FILE TRANSFER PROGRESS */}
          {Object.keys(sendingProgress).length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>📤 Sending Files</Text>
              {Object.entries(sendingProgress).map(([fileId, progress]) => (
                <View key={fileId} style={styles.progressBox}>
                  <Text style={{ fontSize: 12 }}>{progress.fileName}</Text>
                  <View style={styles.progressBarContainer}>
                    <View 
                      style={[
                        styles.progressBar, 
                        { width: `${(progress.current / progress.total) * 100}%` }
                      ]} 
                    />
                  </View>
                  <Text style={{ fontSize: 10, color: 'gray' }}>
                    {progress.current} / {progress.total} chunks
                  </Text>
                </View>
              ))}
            </View>
          )}

          {Object.keys(fileTransfers).length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>📥 Receiving Files</Text>
              {Object.entries(fileTransfers).map(([fileId, transfer]) => (
                <View key={fileId} style={styles.progressBox}>
                  <Text style={{ fontSize: 12 }}>{transfer.fileName}</Text>
                  <View style={styles.progressBarContainer}>
                    <View 
                      style={[
                        styles.progressBar, 
                        { width: `${(transfer.receivedChunks / transfer.totalChunks) * 100}%` }
                      ]} 
                    />
                  </View>
                  <Text style={{ fontSize: 10, color: 'gray' }}>
                    {transfer.receivedChunks} / {transfer.totalChunks} chunks
                  </Text>
                </View>
              ))}
            </View>
          )}

          {/* BROADCAST */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>📢 Broadcast</Text>
            <TextInput
              style={styles.input}
              placeholder="Broadcast message"
              value={broadcastInput}
              onChangeText={setBroadcastInput}
            />
            <Button
              title="Send Broadcast"
              onPress={() => {
                if (broadcastInput.trim()) {
                  initiateBroadcast(broadcastInput.trim());
                  setBroadcastInput('');
                }
              }}
            />
          </View>

          {/* DISTANT MESSAGE */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>🌐 Distant Message</Text>
            <TextInput
              style={styles.input}
              placeholder="Recipient Persistent ID"
              value={distantRecipient}
              onChangeText={setDistantRecipient}
            />
            <TextInput
              style={styles.input}
              placeholder="Message"
              value={distantMessageInput}
              onChangeText={setDistantMessageInput}
            />
            <Button
              title="Send via Network"
              onPress={() => {
                if (distantRecipient.trim() && distantMessageInput.trim()) {
                  sendDistantMessage(distantRecipient.trim(), distantMessageInput.trim());
                  setDistantMessageInput('');
                }
              }}
            />
          </View>

          {/* PEERS */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>👥 Peers</Text>
            {Object.entries(peers).map(([id, info]) => (
              <View key={id} style={styles.peerBox}>
                <Pressable onPress={() => session?.invite(id)}>
                  <Text style={{ fontWeight: 'bold' }}>
                    {info.peer.displayName} (State: {info.state})
                  </Text>
                  <Text style={{ fontSize: 10, color: 'gray' }}>
                    ID: {info.discoveryInfo?.myPersistentID}
                  </Text>
                </Pressable>

                {info.state === PeerState.connected && (
                  <>
                    <Button
                      title="📎 Send File"
                      onPress={() => pickAndSendFile(id)}
                    />

                    <TextInput
                      style={styles.input}
                      placeholder="Direct message"
                      onSubmitEditing={(ev) => {
                        const msg = ev.nativeEvent.text.trim();
                        if (msg) {
                          sendNeighborMessage(id, msg);
                          ev.currentTarget.clear();
                        }
                      }}
                    />

                    <View style={{ marginTop: 10 }}>
                      <Text style={{ fontWeight: 'bold' }}>Messages:</Text>
                      {receivedMessages[id] && receivedMessages[id].length > 0 ? (
                        receivedMessages[id].map((msg, idx) => (
                          <Text key={idx} style={{ fontSize: 12 }}>{msg}</Text>
                        ))
                      ) : (
                        <Text style={{ fontSize: 12, color: 'gray' }}>No messages</Text>
                      )}
                    </View>
                  </>
                )}
              </View>
            ))}
          </View>

          {/* DEBUG */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>🐛 Logs</Text>
            {devLogs.slice(-15).reverse().map((l, i) => (
              <Text key={i} style={{ fontSize: 10 }}>{l}</Text>
            ))}
          </View>
        </View>
      </ScrollView>
    </TouchableWithoutFeedback>
  );
}

const styles = StyleSheet.create({
  scrollContainer: {
    flex: 1,
    backgroundColor: 'white',
  },
  container: {
    flex: 1,
    alignItems: 'center',
    paddingTop: 80,
    paddingBottom: 40,
  },
  section: {
    marginTop: 20,
    width: '90%',
    padding: 15,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 10,
  },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    padding: 8,
    marginVertical: 5,
    borderRadius: 5,
  },
  peerBox: {
    borderWidth: 1,
    borderColor: '#ddd',
    padding: 10,
    marginVertical: 5,
    borderRadius: 5,
    backgroundColor: '#f9f9f9',
  },
  progressBox: {
    padding: 10,
    marginVertical: 5,
    borderWidth: 1,
    borderColor: '#e0e0e0',
    borderRadius: 5,
    backgroundColor: '#f5f5f5',
  },
  progressBarContainer: {
    height: 20,
    backgroundColor: '#e0e0e0',
    borderRadius: 10,
    marginVertical: 5,
    overflow: 'hidden',
  },
  progressBar: {
    height: '100%',
    backgroundColor: '#4CAF50',
  },
});