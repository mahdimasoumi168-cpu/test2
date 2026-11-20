import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:http/http.dart' as http;
import 'package:permission_handler/permission_handler.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'audio_handler.dart';

const String hamyarApiBaseUrl = String.fromEnvironment(
  'API_BASE_URL',
  defaultValue: 'https://test2.mahdi-masoumi168.workers.dev',
);

class VoiceFailure implements Exception {
  VoiceFailure(this.message);
  final String message;
  @override
  String toString() => message;
}

class VoiceController extends ChangeNotifier {
  VoiceController(this.audioHandler) {
    audioHandler.onPauseAudio = pauseAudio;
    audioHandler.onResumeAudio = resumeAudio;
    audioHandler.onStopRoom = disconnectRoom;
  }

  final HamyarAudioHandler audioHandler;
  final http.Client _http = http.Client();

  Map<String, dynamic>? member;
  List<Map<String, dynamic>> rooms = [];
  Map<String, dynamic>? currentRoom;
  String? token;
  String? connectionKey;
  String status = 'برای ورود، اطلاعات عضویت را وارد کنید.';
  String? error;
  bool connected = false;
  bool holding = false;
  bool busy = false;
  bool _iceReady = false;
  bool _disposed = false;

  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _socketSubscription;
  Timer? _roomHeartbeat;
  Timer? _pttHeartbeat;
  Map<String, dynamic>? _iceData;
  RTCPeerConnection? _publisherPc;
  MediaStream? _microphone;
  String? _publisherSessionId;
  RTCPeerConnection? _subscriberPc;
  String? _subscriberSessionId;
  String? _activePublisherId;
  MediaStreamTrack? _remoteAudioTrack;
  bool _playbackPaused = false;
  String? _pendingPublisherSessionId;
  String? _pendingSpeakerId;
  int _subscriberGeneration = 0;
  int _talkGeneration = 0;

  Uri get _baseUri => Uri.parse(hamyarApiBaseUrl);
  bool get canTalk => connected && connectionKey != null && _iceReady;

  Future<Map<String, dynamic>> _request(
    String path, {
    String method = 'GET',
    Map<String, dynamic>? body,
  }) async {
    final uri = _baseUri.resolve(path);
    final headers = <String, String>{'accept': 'application/json'};
    if (token != null) headers['authorization'] = 'Bearer ' + token!;
    if (body != null) headers['content-type'] = 'application/json';
    final encoded = body == null ? null : jsonEncode(body);

    late http.Response response;
    if (method == 'POST') {
      response = await _http.post(uri, headers: headers, body: encoded)
          .timeout(const Duration(seconds: 20));
    } else if (method == 'PUT') {
      response = await _http.put(uri, headers: headers, body: encoded)
          .timeout(const Duration(seconds: 20));
    } else if (method == 'DELETE') {
      response = await _http.delete(uri, headers: headers)
          .timeout(const Duration(seconds: 20));
    } else {
      response = await _http.get(uri, headers: headers)
          .timeout(const Duration(seconds: 20));
    }

    Map<String, dynamic> data = {};
    try {
      final decoded = jsonDecode(response.body);
      if (decoded is Map<String, dynamic>) data = decoded;
    } catch (_) {}

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw VoiceFailure(
        (data['error'] as String?) ??
            'ارتباط با سرور ناموفق بود (' + response.statusCode.toString() + ').',
      );
    }
    return data;
  }

  Future<void> login({
    required String fullName,
    required String guardianCode,
    required String personCode,
  }) async {
    error = null;
    status = 'در حال بررسی اطلاعات ورود...';
    notifyListeners();
    try {
      final data = await _request(
        '/api/login',
        method: 'POST',
        body: {
          'fullName': fullName.trim(),
          'guardianCode': guardianCode.trim(),
          'personCode': personCode.trim(),
        },
      );
      token = data['token'] as String?;
      member = Map<String, dynamic>.from(data['member'] as Map);
      await loadRooms();
      status = 'ورود موفق؛ اتاق مجاز را انتخاب کنید.';
    } catch (e) {
      error = e.toString();
      status = error!;
    }
    notifyListeners();
  }

  Future<void> loadRooms() async {
    final data = await _request('/api/rooms');
    rooms = (data['rooms'] as List? ?? [])
        .whereType<Map>()
        .map((item) => Map<String, dynamic>.from(item))
        .toList();
    notifyListeners();
  }

  Future<void> connectRoom(Map<String, dynamic> room) async {
    if (token == null) return;
    await disconnectRoom();
    error = null;
    currentRoom = room;
    connectionKey = null;
    connected = false;
    _iceReady = false;
    status = 'در حال اتصال به اتاق ' + (room['name']?.toString() ?? '') + '...';
    notifyListeners();

    try {
      await Helper.ensureAudioSession();
      await Helper.setSpeakerphoneOnButPreferBluetooth();
      if (Platform.isAndroid) await Permission.notification.request();
      final uri = _baseUri.replace(
        scheme: _baseUri.scheme == 'https' ? 'wss' : 'ws',
        path: '/api/rooms/' + Uri.encodeComponent(room['id'].toString()) + '/socket',
        query: null,
        fragment: null,
      );
      final channel = WebSocketChannel.connect(
        uri,
        protocols: ['hy-room-v1', 'hy-auth.' + token!],
      );
      _channel = channel;
      await channel.ready.timeout(const Duration(seconds: 15));
      _socketSubscription = channel.stream.listen(
        _onSocketMessage,
        onError: (Object e) => _onSocketClosed('ارتباط اتاق قطع شد: ' + e.toString()),
        onDone: () => _onSocketClosed('ارتباط اتاق بسته شد.'),
        cancelOnError: true,
      );
    } catch (e) {
      error = e.toString();
      status = error!;
      connected = false;
      notifyListeners();
      await disconnectRoom();
    }
  }

  void _onSocketMessage(dynamic raw) {
    if (raw is! String) return;
    Map<String, dynamic> data;
    try {
      data = Map<String, dynamic>.from(jsonDecode(raw) as Map);
    } catch (_) {
      return;
    }
    final type = data['type'];

    if (type == 'room:ready') {
      connectionKey = data['connectionKey'] as String?;
      if (connectionKey == null || connectionKey!.isEmpty) {
        status = 'شناسه امن اتصال دریافت نشد.';
        unawaited(disconnectRoom());
        return;
      }
      connected = true;
      status = 'به اتاق ' + (currentRoom?['name']?.toString() ?? '') +
          ' متصل شدید؛ در حال آماده‌سازی صدا...';
      _roomHeartbeat?.cancel();
      _roomHeartbeat = Timer.periodic(
        const Duration(minutes: 5),
        (_) => _sendSocket({'type': 'room:heartbeat'}),
      );
      audioHandler.setRoom(currentRoom?['name']?.toString());
      unawaited(_loadIceServers());
      notifyListeners();
      return;
    }

    if (type == 'room:presence') {
      status = 'متصل · افراد حاضر: ' + (data['connected'] ?? 0).toString();
      notifyListeners();
    } else if (type == 'ptt:granted') {
      if (data['memberId'] == member?['id'] && holding) {
        unawaited(_startPublisher());
      } else {
        status = (data['memberName'] ?? 'عضو').toString() + ' در حال صحبت است.';
        notifyListeners();
      }
    } else if (type == 'ptt:busy') {
      busy = true;
      status = data['memberName'] == null
          ? 'فرد دیگری در حال صحبت است.'
          : data['memberName'].toString() + ' در حال صحبت است.';
      notifyListeners();
    } else if (type == 'ptt:published') {
      final speakerId = data['memberId'] as String?;
      final sessionId = data['sessionId'] as String?;
      if (speakerId != null && speakerId != member?['id'] && sessionId != null) {
        if (_iceReady) {
          unawaited(_startSubscriber(sessionId, speakerId));
        } else {
          _pendingPublisherSessionId = sessionId;
          _pendingSpeakerId = speakerId;
        }
      }
    } else if (type == 'ptt:released') {
      final speakerId = data['memberId'] as String?;
      if (speakerId == member?['id']) {
        unawaited(releaseTalk());
      } else {
        if (_pendingSpeakerId == speakerId) {
          _pendingSpeakerId = null;
          _pendingPublisherSessionId = null;
        }
        unawaited(_stopSubscriber());
      }
      busy = false;
      status = 'کانال آزاد شد.';
      notifyListeners();
    } else if (type == 'ptt:budget-blocked') {
      unawaited(releaseTalk());
      status = 'شروع صحبت به‌دلیل نزدیک‌شدن به سقف مصرف متوقف شد.';
      notifyListeners();
    } else if (type == 'room:disabled' || type == 'session:revoked') {
      status = 'دسترسی این اتاق لغو شد.';
      unawaited(disconnectRoom());
    }
  }

  Future<void> pauseAudio() async {
    _playbackPaused = true;
    if (_remoteAudioTrack != null) _remoteAudioTrack!.enabled = false;
  }

  Future<void> resumeAudio() async {
    _playbackPaused = false;
    if (_remoteAudioTrack != null) _remoteAudioTrack!.enabled = true;
  }

  Future<void> _loadIceServers() async {
    try {
      _iceData = await _request('/api/ice-servers');
      _iceReady = true;
      status = 'اتصال آماده است؛ برای صحبت دکمه را نگه دارید.';
      final pendingSession = _pendingPublisherSessionId;
      final pendingSpeaker = _pendingSpeakerId;
      _pendingPublisherSessionId = null;
      _pendingSpeakerId = null;
      if (pendingSession != null && pendingSpeaker != null) {
        unawaited(_startSubscriber(pendingSession, pendingSpeaker));
      }
    } catch (e) {
      _iceReady = false;
      status = 'آماده‌سازی مسیر شبکه ناموفق بود: ' + e.toString();
    }
    notifyListeners();
  }

  void requestTalk() {
    if (!canTalk || holding || _channel == null) return;
    holding = true;
    busy = false;
    _talkGeneration++;
    _sendSocket({'type': 'ptt:request'});
    _pttHeartbeat?.cancel();
    _pttHeartbeat = Timer.periodic(
      const Duration(seconds: 10),
      (_) {
        if (holding) _sendSocket({'type': 'ptt:heartbeat'});
      },
    );
    status = 'درخواست نوبت صحبت ارسال شد...';
    notifyListeners();
  }

  Future<void> releaseTalk() async {
    if (!holding && _publisherPc == null && _microphone == null) return;
    holding = false;
    _talkGeneration++;
    _pttHeartbeat?.cancel();
    _pttHeartbeat = null;
    _sendSocket({'type': 'ptt:release'});
    await _stopPublisher();
    notifyListeners();
  }

  Future<void> _startPublisher() async {
    final generation = _talkGeneration;
    if (!holding || connectionKey == null || _publisherPc != null) return;

    RTCPeerConnection? pc;
    MediaStream? stream;
    String? sessionId;
    try {
      final permission = await Permission.microphone.request();
      if (!permission.isGranted) throw VoiceFailure('مجوز میکروفون داده نشد.');
      await Helper.ensureAudioSession();
      await Helper.setSpeakerphoneOnButPreferBluetooth();

      stream = await navigator.mediaDevices.getUserMedia({
        'audio': {
          'echoCancellation': true,
          'noiseSuppression': true,
          'autoGainControl': true,
          'channelCount': 1,
          'sampleRate': 48000,
        },
        'video': false,
      });
      if (!_isCurrentTalk(generation)) throw VoiceFailure('درخواست صحبت لغو شد.');

      pc = await createPeerConnection({
        'sdpSemantics': 'unified-plan',
        'bundlePolicy': 'max-bundle',
        'iceServers': _iceData?['iceServers'] ?? [
          {'urls': 'stun:stun.cloudflare.com:3478'}
        ],
      });
      final track = stream.getAudioTracks().first;
      final transceiver = await pc.addTransceiver(
        track: track,
        init: RTCRtpTransceiverInit(
          direction: TransceiverDirection.SendOnly,
          sendEncodings: [RTCRtpEncoding(maxBitrate: 20000)],
        ),
      );
      final offer = await pc.createOffer({});
      await pc.setLocalDescription(offer);
      await _waitForIce(pc);
      final local = await pc.getLocalDescription();
      final mid = transceiver.mid;
      if (local?.sdp == null || mid == null) {
        throw VoiceFailure('توضیحات اتصال صوتی کامل نشد.');
      }
      if (!_isCurrentTalk(generation)) throw VoiceFailure('درخواست صحبت لغو شد.');

      final created = await _request(
        '/api/sfu/sessions',
        method: 'POST',
        body: {
          'roomId': currentRoom?['id'],
          'type': 'publisher',
          'connectionKey': connectionKey,
        },
      );
      sessionId = created['sessionId'] as String?;
      if (sessionId == null) throw VoiceFailure('شناسه نشست صوتی دریافت نشد.');

      final published = await _request(
        '/api/sfu/sessions/' + Uri.encodeComponent(sessionId) + '/publish',
        method: 'POST',
        body: {
          'sessionDescription': {'type': local!.type, 'sdp': local.sdp},
          'mid': mid,
          'connectionKey': connectionKey,
        },
      );
      final answer = Map<String, dynamic>.from(published['sessionDescription'] as Map);
      await pc.setRemoteDescription(
        RTCSessionDescription(answer['sdp'] as String?, answer['type'] as String?),
      );
      if (!_isCurrentTalk(generation)) throw VoiceFailure('درخواست صحبت لغو شد.');

      _publisherPc = pc;
      _microphone = stream;
      _publisherSessionId = sessionId;
      _sendSocket({'type': 'ptt:published', 'sessionId': sessionId});
      status = 'شما در حال صحبت هستید؛ برای پایان دکمه را رها کنید.';
      notifyListeners();
    } catch (e) {
      if (sessionId != null) {
        unawaited(_request('/api/sfu/sessions/' + Uri.encodeComponent(sessionId), method: 'DELETE').catchError((_) => <String, dynamic>{}));
      }
      if (stream != null) {
        for (final track in stream.getTracks()) {
          try { await track.stop(); } catch (_) {}
        }
        try { await stream.dispose(); } catch (_) {}
      }
      try { await pc?.close(); } catch (_) {}
      try { await pc?.dispose(); } catch (_) {}
      if (holding && generation == _talkGeneration) {
        status = 'ارسال صدا انجام نشد: ' + e.toString();
        await releaseTalk();
      }
    }
  }

  Future<void> _startSubscriber(String publisherSessionId, String speakerId) async {
    if (!connected || _activePublisherId == speakerId) return;
    if (_subscriberPc != null || _activePublisherId != null) {
      await _stopSubscriber();
    }
    final generation = ++_subscriberGeneration;
    _activePublisherId = speakerId;
    RTCPeerConnection? pc;
    String? sessionId;
    try {
      pc = await createPeerConnection({
        'sdpSemantics': 'unified-plan',
        'bundlePolicy': 'max-bundle',
        'iceServers': _iceData?['iceServers'] ?? [
          {'urls': 'stun:stun.cloudflare.com:3478'}
        ],
      });
      if (!_isCurrentSubscriber(generation, speakerId)) throw VoiceFailure('دریافت صدا لغو شد.');
      pc.onTrack = (event) {
        if (event.track.kind == 'audio') {
          _remoteAudioTrack = event.track;
          event.track.enabled = !_playbackPaused;
        }
      };
      final created = await _request(
        '/api/sfu/sessions',
        method: 'POST',
        body: {'roomId': currentRoom?['id'], 'type': 'subscriber'},
      );
      sessionId = created['sessionId'] as String?;
      if (sessionId == null) throw VoiceFailure('شناسه دریافت صدا دریافت نشد.');
      if (!_isCurrentSubscriber(generation, speakerId)) throw VoiceFailure('دریافت صدا لغو شد.');

      final subscribed = await _request(
        '/api/sfu/sessions/' + Uri.encodeComponent(sessionId) + '/subscribe',
        method: 'POST',
        body: {'publisherSessionId': publisherSessionId},
      );
      final offer = Map<String, dynamic>.from(subscribed['sessionDescription'] as Map);
      if (!_isCurrentSubscriber(generation, speakerId)) throw VoiceFailure('دریافت صدا لغو شد.');
      await pc.setRemoteDescription(
        RTCSessionDescription(offer['sdp'] as String?, offer['type'] as String?),
      );
      final answer = await pc.createAnswer({});
      await pc.setLocalDescription(answer);
      await _waitForIce(pc);
      final local = await pc.getLocalDescription();
      if (local?.sdp == null) throw VoiceFailure('پاسخ دریافت صدا کامل نشد.');
      if (!_isCurrentSubscriber(generation, speakerId)) throw VoiceFailure('دریافت صدا لغو شد.');
      await _request(
        '/api/sfu/sessions/' + Uri.encodeComponent(sessionId) + '/renegotiate',
        method: 'PUT',
        body: {'sessionDescription': {'type': local!.type, 'sdp': local.sdp}},
      );
      _subscriberPc = pc;
      _subscriberSessionId = sessionId;
      status = 'در حال شنیدن صدای عضو هیئت...';
      notifyListeners();
    } catch (e) {
      if (sessionId != null) {
        unawaited(_request('/api/sfu/sessions/' + Uri.encodeComponent(sessionId), method: 'DELETE').catchError((_) => <String, dynamic>{}));
      }
      try { await pc?.close(); } catch (_) {}
      try { await pc?.dispose(); } catch (_) {}
      if (generation == _subscriberGeneration) {
        _activePublisherId = null;
        status = 'دریافت صدا برقرار نشد: ' + e.toString();
        notifyListeners();
      }
    }
  }

  bool _isCurrentTalk(int generation) =>
      holding && generation == _talkGeneration && connected && _channel != null;

  Future<void> _waitForIce(RTCPeerConnection pc) async {
    if (pc.iceGatheringState == RTCIceGatheringState.RTCIceGatheringStateComplete) return;
    final completer = Completer<void>();
    final previous = pc.onIceGatheringState;
    pc.onIceGatheringState = (state) {
      previous?.call(state);
      if (state == RTCIceGatheringState.RTCIceGatheringStateComplete &&
          !completer.isCompleted) {
        completer.complete();
      }
    };
    try {
      await completer.future.timeout(const Duration(seconds: 12));
    } on TimeoutException {
      // The local SDP is validated after ICE gathering.
    }
  }

  void _sendSocket(Map<String, dynamic> message) {
    try { _channel?.sink.add(jsonEncode(message)); } catch (_) {}
  }

  Future<void> _stopPublisher() async {
    final pc = _publisherPc;
    final stream = _microphone;
    final sessionId = _publisherSessionId;
    _publisherPc = null;
    _microphone = null;
    _publisherSessionId = null;

    if (stream != null) {
      for (final track in stream.getTracks()) {
        try { await track.stop(); } catch (_) {}
      }
      try { await stream.dispose(); } catch (_) {}
    }
    try { await pc?.close(); } catch (_) {}
    try { await pc?.dispose(); } catch (_) {}
    if (sessionId != null) {
      try {
        await _request('/api/sfu/sessions/' + Uri.encodeComponent(sessionId), method: 'DELETE');
      } catch (_) {}
    }
  }

  bool _isCurrentSubscriber(int generation, String speakerId) =>
      connected && generation == _subscriberGeneration && _activePublisherId == speakerId;

  Future<void> _stopSubscriber() async {
    _subscriberGeneration++;
    final pc = _subscriberPc;
    final sessionId = _subscriberSessionId;
    _subscriberPc = null;
    _subscriberSessionId = null;
    _activePublisherId = null;
    _remoteAudioTrack = null;
    _pendingPublisherSessionId = null;
    _pendingSpeakerId = null;
    try { await pc?.close(); } catch (_) {}
    try { await pc?.dispose(); } catch (_) {}
    if (sessionId != null) {
      try {
        await _request('/api/sfu/sessions/' + Uri.encodeComponent(sessionId), method: 'DELETE');
      } catch (_) {}
    }
  }

  void _onSocketClosed(String message) {
    if (_disposed || _channel == null) return;
    connected = false;
    connectionKey = null;
    _iceReady = false;
    _remoteAudioTrack = null;
    status = message;
    _roomHeartbeat?.cancel();
    _roomHeartbeat = null;
    unawaited(releaseTalk());
    unawaited(_stopSubscriber());
    audioHandler.setRoom(null);
    notifyListeners();
  }

  Future<void> disconnectRoom() async {
    _roomHeartbeat?.cancel();
    _roomHeartbeat = null;
    _pttHeartbeat?.cancel();
    _pttHeartbeat = null;
    if (holding || _publisherPc != null || _microphone != null) {
      await releaseTalk();
    }
    await _stopSubscriber();
    final old = _channel;
    _channel = null;
    await _socketSubscription?.cancel();
    _socketSubscription = null;
    try { await old?.sink.close(); } catch (_) {}
    connected = false;
    connectionKey = null;
    _iceReady = false;
    currentRoom = null;
    audioHandler.setRoom(null);
    notifyListeners();
  }

  Future<void> logout() async {
    await disconnectRoom();
    try { await _request('/api/logout', method: 'POST'); } catch (_) {}
    token = null;
    member = null;
    rooms = [];
    status = 'از حساب خارج شدید.';
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _roomHeartbeat?.cancel();
    _pttHeartbeat?.cancel();
    _socketSubscription?.cancel();
    _channel?.sink.close();
    _http.close();
    super.dispose();
  }
}
