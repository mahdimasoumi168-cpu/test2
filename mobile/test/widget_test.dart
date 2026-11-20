import 'package:flutter_test/flutter_test.dart';
import 'package:hamyar_heyat/audio_handler.dart';
import 'package:hamyar_heyat/main.dart';

void main() {
  testWidgets('shows Persian member login screen', (tester) async {
    await tester.pumpWidget(HamyarApp(audioHandler: HamyarAudioHandler()));
    expect(find.text('همیار هیئت'), findsOneWidget);
    expect(find.text('نام و نام خانوادگی'), findsOneWidget);
    expect(find.text('کد سرپرستی'), findsOneWidget);
    expect(find.text('کد شخص'), findsOneWidget);
  });
}
