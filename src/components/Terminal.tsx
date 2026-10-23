import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  StyleProp,
  StyleSheet,
  Text,
  TextProps,
  View,
  ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, F, glow } from '../theme';

/** Glowing monospace text. */
export function T({
  style,
  color = C.green,
  size = 15,
  display,
  ...rest
}: TextProps & { color?: string; size?: number; display?: boolean }) {
  return (
    <Text
      {...rest}
      style={[
        { color, fontSize: size, fontFamily: display ? F.display : F.mono },
        glow,
        { textShadowColor: color + 'aa' },
        style,
      ]}
    />
  );
}

export function Cursor({ color = C.green, size = 15 }: { color?: string; size?: number }) {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const t = setInterval(() => setOn((v) => !v), 530);
    return () => clearInterval(t);
  }, []);
  return <T color={color} size={size} style={{ opacity: on ? 1 : 0 }}>█</T>;
}

/** Types text out character by character. */
export function TypeText({
  text,
  speed = 18,
  instant,
  onDone,
  ...rest
}: React.ComponentProps<typeof T> & { text: string; speed?: number; instant?: boolean; onDone?: () => void }) {
  const [n, setN] = useState(instant ? text.length : 0);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (instant) {
      setN(text.length);
      return;
    }
    setN(0);
    let i = 0;
    const step = Math.max(1, Math.ceil(text.length / 120)); // long text still finishes quickly
    const t = setInterval(() => {
      i = Math.min(text.length, i + step);
      setN(i);
      if (i >= text.length) {
        clearInterval(t);
        done.current?.();
      }
    }, speed);
    return () => clearInterval(t);
  }, [text, speed, instant]);
  return <T {...rest}>{text.slice(0, n)}</T>;
}

export function Btn({
  label,
  onPress,
  color = C.green,
  disabled,
  style,
  size = 16,
}: {
  label: string;
  onPress: () => void;
  color?: string;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  size?: number;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      style={({ pressed }) => [
        styles.btn,
        { borderColor: color, opacity: disabled ? 0.35 : 1, backgroundColor: pressed ? color : 'transparent' },
        style,
      ]}
    >
      {({ pressed }) => (
        <T color={pressed ? C.bg : color} size={size} style={pressed ? { textShadowRadius: 0 } : undefined}>
          [ {label} ]
        </T>
      )}
    </Pressable>
  );
}

export function Rule({ color = C.greenDim, label }: { color?: string; label?: string }) {
  return (
    <View style={styles.rule}>
      <View style={[styles.ruleLine, { backgroundColor: color }]} />
      {label ? (
        <T color={color} size={12} style={{ marginHorizontal: 8 }}>
          {label}
        </T>
      ) : null}
      <View style={[styles.ruleLine, { backgroundColor: color }]} />
    </View>
  );
}

/** Scanlines, flicker and vignette on top of everything. */
function CRT() {
  const flicker = useRef(new Animated.Value(0)).current;
  const roll = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const f = Animated.loop(
      Animated.sequence([
        Animated.timing(flicker, { toValue: 1, duration: 90, useNativeDriver: true }),
        Animated.timing(flicker, { toValue: 0, duration: 140, useNativeDriver: true }),
        Animated.delay(2600),
      ])
    );
    const r = Animated.loop(
      Animated.timing(roll, { toValue: 1, duration: 7000, easing: Easing.linear, useNativeDriver: true })
    );
    f.start();
    r.start();
    return () => {
      f.stop();
      r.stop();
    };
  }, [flicker, roll]);

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View style={styles.scanlines}>
        {Array.from({ length: 320 }, (_, i) => (
          <View key={i} style={styles.scanline} />
        ))}
      </View>
      <Animated.View
        style={[
          styles.rollBar,
          { transform: [{ translateY: roll.interpolate({ inputRange: [0, 1], outputRange: [-120, 1000] }) }] },
        ]}
      />
      <Animated.View
        style={[StyleSheet.absoluteFill, { backgroundColor: C.green, opacity: flicker.interpolate({ inputRange: [0, 1], outputRange: [0, 0.025] }) }]}
      />
      <View style={styles.vignette} />
    </View>
  );
}

export function Screen({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.root}>
      <View
        style={[
          { flex: 1, paddingTop: insets.top + 8, paddingBottom: insets.bottom + 8, paddingHorizontal: 14 },
          style,
        ]}
      >
        {children}
      </View>
      <CRT />
    </View>
  );
}

export const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  btn: { borderWidth: 1, paddingVertical: 10, paddingHorizontal: 14, alignItems: 'center' },
  rule: { flexDirection: 'row', alignItems: 'center', marginVertical: 8 },
  ruleLine: { flex: 1, height: 1, opacity: 0.6 },
  scanlines: { ...StyleSheet.absoluteFill, overflow: 'hidden' },
  scanline: { height: 1, marginBottom: 2, backgroundColor: '#000', opacity: 0.35 },
  rollBar: { position: 'absolute', left: 0, right: 0, height: 90, backgroundColor: C.green, opacity: 0.03 },
  vignette: {
    ...StyleSheet.absoluteFill,
    borderWidth: 26,
    borderColor: 'rgba(0,0,0,0.35)',
    borderRadius: 34,
    margin: -14,
  },
});

