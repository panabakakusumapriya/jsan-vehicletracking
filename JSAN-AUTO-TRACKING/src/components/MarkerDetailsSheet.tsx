import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Image } from 'expo-image';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import type { MarkerCategory } from '@/src/lib/api';

/**
 * What a marker needs before it is dropped: WHY the spot was flagged and a PHOTO of it.
 *
 * Opens after the driver has placed the pin. The reason is one of the reasons the admins listed
 * under that colour (MarkerCategory.description, edited on the portal's Markers page), or "Other"
 * with the driver's own words; a few extra words are always welcome. At least one photo is needed,
 * up to three — taken with the camera, or picked from the gallery when the moment has passed.
 *
 * Every picture is shrunk to a ~1600 px JPEG here, on the phone: a camera original is 4-8 MB and
 * would take minutes to upload on the weak signal markers are dropped in; this is a few hundred KB.
 */
export const MIN_PHOTOS = 1;
export const MAX_PHOTOS = 3;
const MAX_EDGE_PX = 1600;
const JPEG_QUALITY = 0.7;
const OTHER = 'Other';

export type MarkerDetails = {
  reason: string;
  note: string;
  photos: { uri: string; width: number; height: number; bytes?: number }[];
};

/** The reasons an admin listed under a colour: "Tunnel, Traffic Accident, …". */
export function reasonsOf(cat: MarkerCategory | null): string[] {
  const list = String(cat?.description || '')
    .split(/[,\n]/)
    .map((r) => r.trim())
    .filter(Boolean);
  return [...new Set(list)];
}

/** Shrink to MAX_EDGE_PX on the long side and re-encode as JPEG. */
async function shrink(asset: ImagePicker.ImagePickerAsset) {
  const long = Math.max(asset.width || 0, asset.height || 0);
  const actions = long > MAX_EDGE_PX
    ? [{ resize: asset.width >= asset.height ? { width: MAX_EDGE_PX } : { height: MAX_EDGE_PX } }]
    : [];
  const out = await manipulateAsync(asset.uri, actions, { compress: JPEG_QUALITY, format: SaveFormat.JPEG });
  return { uri: out.uri, width: out.width, height: out.height };
}

export function MarkerDetailsSheet({
  category,
  onCancel,
  onSave,
}: {
  /** Open while set: the colour the driver is dropping. */
  category: MarkerCategory | null;
  onCancel: () => void;
  onSave: (details: MarkerDetails) => void;
}) {
  const reasons = useMemo(() => reasonsOf(category), [category]);
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [photos, setPhotos] = useState<MarkerDetails['photos']>([]);
  const [busy, setBusy] = useState(false);

  // A fresh form for every drop.
  useEffect(() => {
    if (!category) return;
    setReason(null);
    setNote('');
    setPhotos([]);
    setBusy(false);
  }, [category]);

  const other = reason === OTHER || reasons.length === 0;
  const typed = note.trim();
  const reasonOk = other ? typed.length >= 3 : Boolean(reason);
  const photosOk = photos.length >= MIN_PHOTOS;
  const missing = !reasonOk
    ? (other ? 'Write the reason (a few words)' : 'Pick the reason')
    : !photosOk ? 'Add a photo of the spot' : null;

  const add = async (from: 'camera' | 'gallery') => {
    if (busy || photos.length >= MAX_PHOTOS) return;
    try {
      const perm = from === 'camera'
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(
          from === 'camera' ? 'Camera is off for this app' : 'Photos are off for this app',
          from === 'camera'
            ? 'Allow the camera to photograph the spot, or pick a photo from the gallery instead.'
            : 'Allow photo access to pick a picture of the spot.',
          [
            { text: 'Not now', style: 'cancel' },
            { text: 'Open settings', onPress: () => { void Linking.openSettings(); } },
          ],
        );
        return;
      }
      const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.8, exif: false };
      const res = from === 'camera'
        ? await ImagePicker.launchCameraAsync(opts)
        : await ImagePicker.launchImageLibraryAsync({ ...opts, allowsMultipleSelection: true, selectionLimit: MAX_PHOTOS - photos.length });
      if (res.canceled || !res.assets?.length) return;
      setBusy(true);
      const shrunk: MarkerDetails['photos'] = [];
      for (const a of res.assets.slice(0, MAX_PHOTOS - photos.length)) shrunk.push(await shrink(a));
      setPhotos((cur) => [...cur, ...shrunk].slice(0, MAX_PHOTOS));
    } catch {
      Alert.alert('Could not add the photo', 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    if (missing || busy) return;
    onSave({
      reason: other ? typed : (reason as string),
      note: other ? '' : typed,
      photos,
    });
  };

  return (
    <Modal visible={Boolean(category)} transparent animationType="slide" onRequestClose={onCancel}>
      <KeyboardAvoidingView style={s.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={s.sheet}>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 6 }}>
            <View style={s.head}>
              <View style={[s.dot, { backgroundColor: category?.color ?? '#ef4444' }]} />
              <Text style={s.title}>{category?.name ?? 'Marker'}</Text>
            </View>
            <Text style={s.sub}>Why are you flagging this spot? Add a photo so the office can see it.</Text>

            <Text style={s.label}>Reason</Text>
            {reasons.length > 0 && (
              <View style={s.chips}>
                {[...reasons, OTHER].map((r) => {
                  const on = reason === r;
                  return (
                    <TouchableOpacity
                      key={r}
                      style={[s.chip, on && { backgroundColor: category?.color ?? '#2563eb', borderColor: category?.color ?? '#2563eb' }]}
                      onPress={() => setReason(r)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: on }}
                    >
                      <Text style={[s.chipTxt, on && s.chipTxtOn]}>{r}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
            <TextInput
              style={s.input}
              value={note}
              onChangeText={setNote}
              placeholder={other ? 'What is here? (required)' : 'Anything more? (optional)'}
              placeholderTextColor="#94a3b8"
              multiline
              maxLength={300}
            />

            <Text style={s.label}>Photo{MAX_PHOTOS > 1 ? `s (${photos.length}/${MAX_PHOTOS})` : ''}</Text>
            <View style={s.photoRow}>
              {photos.map((ph, i) => (
                <View key={ph.uri} style={s.thumbWrap}>
                  <Image source={{ uri: ph.uri }} style={s.thumb} contentFit="cover" />
                  <TouchableOpacity
                    style={s.thumbX}
                    onPress={() => setPhotos((cur) => cur.filter((_, j) => j !== i))}
                    accessibilityLabel="Remove this photo"
                    hitSlop={8}
                  >
                    <FontAwesome name="times" size={12} color="#ffffff" />
                  </TouchableOpacity>
                </View>
              ))}
              {busy && <View style={[s.thumb, s.thumbBusy]}><ActivityIndicator color="#2563eb" /></View>}
            </View>
            {photos.length < MAX_PHOTOS && (
              <View style={s.photoBtns}>
                <TouchableOpacity style={s.photoBtn} onPress={() => add('camera')} disabled={busy} accessibilityRole="button">
                  <FontAwesome name="camera" size={15} color="#0f172a" />
                  <Text style={s.photoBtnTxt}>Take photo</Text>
                </TouchableOpacity>
                <TouchableOpacity style={s.photoBtn} onPress={() => add('gallery')} disabled={busy} accessibilityRole="button">
                  <FontAwesome name="image" size={15} color="#0f172a" />
                  <Text style={s.photoBtnTxt}>Gallery</Text>
                </TouchableOpacity>
              </View>
            )}
          </ScrollView>

          {missing && <Text style={s.missing}>{missing}</Text>}
          <View style={s.actions}>
            <TouchableOpacity style={s.cancel} onPress={onCancel} accessibilityRole="button">
              <Text style={s.cancelTxt}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.save, (missing || busy) && s.saveOff]}
              onPress={save}
              disabled={Boolean(missing) || busy}
              accessibilityRole="button"
            >
              <Text style={s.saveTxt}>Save marker</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#ffffff', borderTopLeftRadius: 18, borderTopRightRadius: 18,
    paddingHorizontal: 18, paddingTop: 16, paddingBottom: 18, maxHeight: '88%',
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dot: { width: 14, height: 14, borderRadius: 7 },
  title: { fontSize: 18, fontWeight: '800', color: '#0f172a' },
  sub: { fontSize: 13, color: '#64748b', marginTop: 4, lineHeight: 18 },
  label: { fontSize: 12, fontWeight: '800', color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 16, marginBottom: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  chip: { borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: '#f8fafc' },
  chipTxt: { fontSize: 13.5, color: '#0f172a', fontWeight: '600' },
  chipTxtOn: { color: '#ffffff' },
  input: {
    borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10,
    fontSize: 14.5, color: '#0f172a', minHeight: 48, textAlignVertical: 'top',
  },
  photoRow: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  thumbWrap: { position: 'relative' },
  thumb: { width: 88, height: 88, borderRadius: 12, backgroundColor: '#e2e8f0' },
  thumbBusy: { alignItems: 'center', justifyContent: 'center' },
  thumbX: {
    position: 'absolute', top: 4, right: 4, width: 22, height: 22, borderRadius: 11,
    backgroundColor: 'rgba(15,23,42,0.75)', alignItems: 'center', justifyContent: 'center',
  },
  photoBtns: { flexDirection: 'row', gap: 10, marginTop: 10 },
  photoBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 12, paddingVertical: 12, backgroundColor: '#f8fafc',
  },
  photoBtnTxt: { fontSize: 14, fontWeight: '700', color: '#0f172a' },
  missing: { fontSize: 12.5, color: '#b45309', fontWeight: '700', marginTop: 10, textAlign: 'center' },
  actions: { flexDirection: 'row', gap: 10, marginTop: 10 },
  cancel: { flex: 1, borderRadius: 12, paddingVertical: 14, alignItems: 'center', backgroundColor: '#f1f5f9' },
  cancelTxt: { fontSize: 15, fontWeight: '800', color: '#334155' },
  save: { flex: 2, borderRadius: 12, paddingVertical: 14, alignItems: 'center', backgroundColor: '#2563eb' },
  saveOff: { backgroundColor: '#93c5fd' },
  saveTxt: { fontSize: 15, fontWeight: '800', color: '#ffffff' },
});
