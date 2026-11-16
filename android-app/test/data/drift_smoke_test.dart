import 'package:drift/drift.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/data/db/app_database.dart';

void main() {
  test('drift 内存库冒烟：建表＋读写', () async {
    final db = QfDatabase.memory();
    await db.upsertDevice(const DevicesCompanion(
      nodeId: Value('node-1'),
      name: Value('测试机'),
      os: Value('Windows 11'),
    ));
    final row = await db.deviceByNodeId('node-1');
    expect(row?.name, '测试机');
    await db.close();
  });
}
