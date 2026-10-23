import React, { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Cursor, Screen, T, TypeText } from '../components/Terminal';
import { C } from '../theme';

export const BANNER = [
  ' ___ _      _   ___ _  _____  _____  __',
  '| _ ) |    /_\\ / __| |/ / _ )/ _ \\ \\/ /',
  '| _ \\ |__ / _ \\ (__| \' <| _ \\ (_) >  < ',
  '|___/____/_/ \\_\\___|_|\\_\\___/\\___/_/\\_\\',
].join('\n');

const LINES: [string, string][] = [
  ['BLACKBOX BIOS v2.6.1  (C) 1987 NULL SECTOR SYSTEMS', C.greenDim],
  ['MEMORY CHECK ............... 640K OK', C.green],
  ['LOADING RADIO STACK ........ OK', C.green],
  ['BLE TRANSCEIVER ............ DETECTED', C.green],
  ['CELL TOWERS ................ IGNORED', C.amber],
  ['INTERNET ................... NOT REQUIRED', C.amber],
  ['CURVE25519 / XSALSA20 ...... ARMED', C.green],
  ['MOUNTING SECURE CHANNEL .... DONE', C.green],
];

export function BootScreen({ onDone }: { onDone: () => void }) {
  const [line, setLine] = useState(0);
  const finished = line >= LINES.length;

  useEffect(() => {
    if (!finished) return;
    const t = setTimeout(onDone, 1400);
    return () => clearTimeout(t);
  }, [finished, onDone]);

  return (
    <Pressable style={{ flex: 1 }} onPress={onDone}>
      <Screen>
        <View style={{ flex: 1, justifyContent: 'center' }}>
          {LINES.slice(0, line + 1).map(([text, color], i) => (
            <TypeText
              key={i}
              text={text}
              color={color}
              size={13}
              speed={8}
              instant={i < line}
              onDone={() => i === line && setTimeout(() => setLine((l) => l + 1), 120)}
            />
          ))}
          {finished && (
            <View style={{ marginTop: 28 }}>
              <T size={11} style={{ lineHeight: 13 }}>
                {BANNER}
              </T>
              <T color={C.greenDim} size={12} style={{ marginTop: 10 }}>
                OFF-GRID MESSAGING // BLUETOOTH ONLY
              </T>
            </View>
          )}
          <View style={{ marginTop: 10 }}>
            <Cursor />
          </View>
        </View>
        <T color={C.greenFaint} size={11} style={{ textAlign: 'center' }}>
          TAP TO SKIP
        </T>
      </Screen>
    </Pressable>
  );
}
