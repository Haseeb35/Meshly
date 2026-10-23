import React, { useCallback, useEffect, useState } from 'react';
import { Platform, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useFonts } from 'expo-font';
import { VT323_400Regular } from '@expo-google-fonts/vt323';
import { ShareTechMono_400Regular } from '@expo-google-fonts/share-tech-mono';
import { ChatProvider, useChat } from './src/store';
import { BootScreen } from './src/screens/Boot';
import { IdentityScreen } from './src/screens/Identity';
import { LinkScreen } from './src/screens/Link';
import { RadarScreen } from './src/screens/Radar';
import { ChatScreen } from './src/screens/Chat';
import { NewGroupScreen } from './src/screens/NewGroup';
import { LockScreen, ScreenShield, useAppLock } from './src/security';
import { C } from './src/theme';

function Router() {
  const { loaded, identity, link, log } = useChat();
  const lock = useAppLock();
  const [booted, setBooted] = useState(false);
  const [chat, setChat] = useState<string | null>(null);
  const [newGroup, setNewGroup] = useState(false);
  const finishBoot = useCallback(() => setBooted(true), []);
  const closeChat = useCallback(() => setChat(null), []);
  const closeNewGroup = useCallback(() => setNewGroup(false), []);
  const openCreated = useCallback((key: string) => {
    setNewGroup(false);
    setChat(key);
  }, []);

  useEffect(() => {
    if (lock.state === 'unavailable' && Platform.OS !== 'web') {
      log('NO SCREEN LOCK ON THIS PHONE. SET ONE TO PROTECT BLACKBOX.', 'warn');
    }
  }, [lock.state, log]);

  if (!booted) return <BootScreen onDone={finishBoot} />;
  if (!loaded || lock.state === 'checking') return null;
  if (lock.state === 'locked') return <LockScreen unlock={lock.unlock} />;
  if (!identity) return <IdentityScreen />;
  if (link === 'offline' || link === 'error' || link === 'starting') return <LinkScreen />;
  if (newGroup) return <NewGroupScreen onBack={closeNewGroup} onCreated={openCreated} />;
  if (chat) return <ChatScreen chatKey={chat} onBack={closeChat} />;
  return <RadarScreen onOpen={setChat} onNewGroup={() => setNewGroup(true)} />;
}

export default function App() {
  const [fontsLoaded] = useFonts({ VT323_400Regular, ShareTechMono_400Regular });
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {/* Off in dev builds so screenshots / screen sharing work while testing. */}
      {!__DEV__ && <ScreenShield />}
      <View style={{ flex: 1, backgroundColor: C.bg }}>
        {fontsLoaded && (
          <ChatProvider>
            <Router />
          </ChatProvider>
        )}
      </View>
    </SafeAreaProvider>
  );
}
