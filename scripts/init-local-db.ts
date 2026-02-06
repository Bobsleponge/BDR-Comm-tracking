import { getLocalDB } from '../lib/db/local-db';
import { generateUUID } from '../lib/utils/uuid';

const db = getLocalDB();

// Create test users
const testAdmin = {
  id: generateUUID(),
  name: 'Admin User',
  email: 'admin@example.com',
  status: 'active',
};

const testBDR = {
  id: generateUUID(),
  name: 'Test BDR',
  email: 'test@example.com',
  status: 'active',
};

db.prepare(`
  INSERT OR IGNORE INTO bdr_reps (id, name, email, status)
  VALUES (?, ?, ?, ?)
`).run(testAdmin.id, testAdmin.name, testAdmin.email, testAdmin.status);

db.prepare(`
  INSERT OR IGNORE INTO bdr_reps (id, name, email, status)
  VALUES (?, ?, ?, ?)
`).run(testBDR.id, testBDR.name, testBDR.email, testBDR.status);

console.log('Local database initialized with test data');
console.log('\nTest Users Created:');
console.log('Admin:', testAdmin.email, '(password: any)');
console.log('BDR:', testBDR.email, '(password: any)');
console.log('\nYou can log in with either email address.');

