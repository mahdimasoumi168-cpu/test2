import 'package:audio_service/audio_service.dart';

class HamyarAudioHandler extends BaseAudioHandler {
  String? _roomName;
  Future<void> Function()? onPauseAudio;
  Future<void> Function()? onResumeAudio;
  Future<void> Function()? onStopRoom;
  Future<void> Function()? onStopRoom;

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
    await onResumeAudio?.call();
    playbackState.add(playbackState.value.copyWith(playing: true));
  }

  @override
  Future<void> pause() async {
    await onPauseAudio?.call();
    playbackState.add(playbackState.value.copyWith(playing: false));
  }

  @override
  Future<void> stop() async {
    await Helper.pauseAudioPlayout();
    await onStopRoom?.call();
    setRoom(null);
    await super.stop();
  }

  String? get roomName => _roomName;
}
