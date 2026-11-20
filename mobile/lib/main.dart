import 'package:audio_service/audio_service.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';

import 'audio_handler.dart';
import 'voice_controller.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final handler = await AudioService.init(
    builder: HamyarAudioHandler.new,
    config: const AudioServiceConfig(
      androidNotificationChannelId: 'ir.heyat.hamyar.audio',
      androidNotificationChannelName: 'همیار هیئت',
      androidNotificationOngoing: true,
      androidStopForegroundOnPause: false,
    ),
  );
  runApp(HamyarApp(audioHandler: handler as HamyarAudioHandler));
}

class HamyarApp extends StatefulWidget {
  const HamyarApp({super.key, required this.audioHandler});
  final HamyarAudioHandler audioHandler;

  @override
  State<HamyarApp> createState() => _HamyarAppState();
}

class _HamyarAppState extends State<HamyarApp> with WidgetsBindingObserver {
  late final VoiceController controller;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    controller = VoiceController(widget.audioHandler);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.inactive ||
        state == AppLifecycleState.paused ||
        state == AppLifecycleState.hidden) {
      controller.releaseTalk();
    } else if (state == AppLifecycleState.resumed && controller.connected) {
      Helper.resumeAudioPlayout();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      title: 'همیار هیئت',
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF145A91),
          primary: const Color(0xFF145A91),
        ),
        scaffoldBackgroundColor: const Color(0xFFF2F5F9),
      ),
      home: Directionality(
        textDirection: TextDirection.rtl,
        child: AnimatedBuilder(
          animation: controller,
          builder: (context, _) => controller.member == null
              ? LoginPage(controller: controller)
              : HomePage(controller: controller),
        ),
      ),
    );
  }
}

class LoginPage extends StatefulWidget {
  const LoginPage({super.key, required this.controller});
  final VoiceController controller;

  @override
  State<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  final _formKey = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _guardian = TextEditingController();
  final _person = TextEditingController();
  bool _loading = false;

  @override
  void dispose() {
    _name.dispose();
    _guardian.dispose();
    _person.dispose();
    super.dispose();
  }

  Future<void> _login() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() => _loading = true);
    await widget.controller.login(
      fullName: _name.text,
      guardianCode: _guardian.text,
      personCode: _person.text,
    );
    if (mounted) setState(() => _loading = false);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(22),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 460),
              child: Card(
                elevation: 2,
                child: Padding(
                  padding: const EdgeInsets.all(22),
                  child: Form(
                    key: _formKey,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        const Icon(Icons.record_voice_over_rounded, size: 54, color: Color(0xFF145A91)),
                        const SizedBox(height: 12),
                        const Text('همیار هیئت', textAlign: TextAlign.center, style: TextStyle(fontSize: 25, fontWeight: FontWeight.bold)),
                        const SizedBox(height: 6),
                        const Text('سامانه ارتباط صوتی اعضای هیئت', textAlign: TextAlign.center),
                        const SizedBox(height: 24),
                        TextFormField(
                          controller: _name,
                          textInputAction: TextInputAction.next,
                          decoration: const InputDecoration(labelText: 'نام و نام خانوادگی', border: OutlineInputBorder()),
                          validator: (v) => (v == null || v.trim().isEmpty) ? 'نام را وارد کنید.' : null,
                        ),
                        const SizedBox(height: 12),
                        TextFormField(
                          controller: _guardian,
                          obscureText: true,
                          keyboardType: TextInputType.number,
                          inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                          textInputAction: TextInputAction.next,
                          decoration: const InputDecoration(labelText: 'کد سرپرستی', border: OutlineInputBorder()),
                          validator: (v) => (v == null || v.trim().isEmpty) ? 'کد سرپرستی را وارد کنید.' : null,
                        ),
                        const SizedBox(height: 12),
                        TextFormField(
                          controller: _person,
                          obscureText: true,
                          keyboardType: TextInputType.number,
                          inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                          decoration: const InputDecoration(labelText: 'کد شخص', border: OutlineInputBorder()),
                          onFieldSubmitted: (_) => _login(),
                          validator: (v) => (v == null || v.trim().isEmpty) ? 'کد شخص را وارد کنید.' : null,
                        ),
                        const SizedBox(height: 18),
                        FilledButton(
                          onPressed: _loading ? null : _login,
                          child: _loading
                              ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2))
                              : const Text('ورود به سامانه'),
                        ),
                        const SizedBox(height: 12),
                        Text(
                          widget.controller.error ?? widget.controller.status,
                          textAlign: TextAlign.center,
                          style: TextStyle(
                            color: widget.controller.error == null ? Colors.blueGrey : Colors.red,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class HomePage extends StatelessWidget {
  const HomePage({super.key, required this.controller});
  final VoiceController controller;

  @override
  Widget build(BuildContext context) {
    final name = controller.member?['name'] ??
        controller.member?['display_name'] ??
        '';
    return Scaffold(
      appBar: AppBar(
        title: const Text('همیار هیئت'),
        actions: [
          IconButton(
            tooltip: 'خروج از حساب',
            onPressed: controller.logout,
            icon: const Icon(Icons.logout),
          ),
        ],
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Card(
              child: ListTile(
                leading: const CircleAvatar(child: Icon(Icons.person)),
                title: Text(name.toString()),
                subtitle: Text(controller.connected ? 'متصل به اتاق' : 'وضعیت: ' + controller.status),
              ),
            ),
            const SizedBox(height: 12),
            const Text('اتاق‌های مجاز', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
            const SizedBox(height: 8),
            if (controller.rooms.isEmpty)
              const Card(
                child: Padding(
                  padding: EdgeInsets.all(18),
                  child: Text('هنوز دسترسی اتاقی برای حساب شما تعیین نشده است. با مدیر سامانه تماس بگیرید.'),
                ),
              )
            else
              ...controller.rooms.map((room) {
                final selected = controller.currentRoom?['id'] == room['id'];
                return Card(
                  child: ListTile(
                    leading: const Icon(Icons.groups_2_outlined),
                    title: Text(room['name']?.toString() ?? ''),
                    subtitle: Text(selected && controller.connected ? 'متصل' : 'برای ورود انتخاب کنید'),
                    trailing: selected && controller.connected
                        ? const Icon(Icons.check_circle, color: Colors.green)
                        : const Icon(Icons.chevron_left),
                    onTap: controller.connected ? null : () => controller.connectRoom(room),
                  ),
                );
              }),
            if (controller.currentRoom != null) ...[
              const SizedBox(height: 14),
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(18),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Text(
                        'اتاق ' + (controller.currentRoom?['name']?.toString() ?? ''),
                        textAlign: TextAlign.center,
                        style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 18),
                      ),
                      const SizedBox(height: 8),
                      Text(controller.status, textAlign: TextAlign.center),
                      const SizedBox(height: 16),
                      Listener(
                        onPointerDown: (_) => controller.requestTalk(),
                        onPointerUp: (_) => controller.releaseTalk(),
                        onPointerCancel: (_) => controller.releaseTalk(),
                        onPointerExit: (_) => controller.releaseTalk(),
                        child: AnimatedContainer(
                          duration: const Duration(milliseconds: 120),
                          height: 112,
                          decoration: BoxDecoration(
                            color: controller.holding
                                ? const Color(0xFFB52D3A)
                                : const Color(0xFF145A91),
                            borderRadius: BorderRadius.circular(18),
                          ),
                          child: Center(
                            child: Column(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Icon(
                                  controller.holding ? Icons.mic : Icons.mic_none,
                                  color: Colors.white,
                                  size: 34,
                                ),
                                const SizedBox(height: 6),
                                Text(
                                  controller.holding ? 'در حال ارسال صدا' : 'برای صحبت نگه دارید',
                                  style: const TextStyle(
                                    color: Colors.white,
                                    fontWeight: FontWeight.bold,
                                    fontSize: 18,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(height: 12),
                      OutlinedButton.icon(
                        onPressed: controller.disconnectRoom,
                        icon: const Icon(Icons.logout),
                        label: const Text('خروج از اتاق'),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
