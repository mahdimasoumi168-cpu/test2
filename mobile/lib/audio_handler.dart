import 'package:audio_service/audio_service.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';

class HamyarAudioHandler extends BaseAudioHandler {
  String? _roomName;

  void setRoom(String? roomName) {
    _roomName = roomName;
    if (roomName == null) {
      mediaItem.add(null);
      playbackState.add(
        playbackState.value.copyWith(
          controls: const [MediaControl.play],
          processingState: AudioProcessingState.idle,
          playing: false,
        ),
      );
      return;
    }

    mediaItem.add(
      MediaItem(
        id: 'hamyar:$roomName',
        title: 'همیار هیئت',
        album: roomName,
        artist: 'ارتباط صوتی زنده',
      ),
    );
    playbackState.add(
      playbackState.value.copyWith(
        controls: const [MediaControl.pause, MediaControl.stop],
        androidCompactActionIndices: const [0, 1],
        processingState: AudioProcessingState.ready,
        playing: true,
      ),
    );
  }

  @override
  Future<void> play() async {
    await Helper.resumeAudioPlayout();
    playbackState.add(playbackState.value.copyWith(playing: true));
  }

  @override
  Future<void> pause() async {
    await Helper.pauseAudioPlayout();
    playbackState.add(playbackState.value.copyWith(playing: false));
  }

  @override
  Future<void> stop() async {
    await Helper.pauseAudioPlayout();
    setRoom(null);
    await super.stop();
  }

  String? get roomName => _roomName;
}
