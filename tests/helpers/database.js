import { openDatabase } from '../../server/db/database.js';
import { migrate } from '../../server/db/migrate.js';

export function createTestDatabase() {
  const db = openDatabase({ filename: ':memory:' });
  migrate(db);

  return {
    db,
    close() {
      db.close();
    }
  };
}
