const fs = require('fs');
const path = require('path');
const dbDir = path.join(__dirname, '..');
const backupDir = path.join(dbDir, 'backups');
const dbPath = path.join(dbDir, 'database.sqlite');
const MAX_BACKUPS = 7;
let lastBackupTime = 0;

function ensureBackupDir() {
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }
}

function createBackup() {
  try {
    if (!fs.existsSync(dbPath)) {
      console.log('  Backup: database.sqlite no encontrado, se omite');
      return null;
    }
    ensureBackupDir();
    const date = new Date();
    const timestamp = date.getFullYear() +
      String(date.getMonth() + 1).padStart(2, '0') +
      String(date.getDate()).padStart(2, '0') + '_' +
      String(date.getHours()).padStart(2, '0') +
      String(date.getMinutes()).padStart(2, '0') +
      String(date.getSeconds()).padStart(2, '0');
    const backupFile = path.join(backupDir, 'database_' + timestamp + '.sqlite');
    fs.copyFileSync(dbPath, backupFile);
    lastBackupTime = Date.now();
    console.log('  Backup: ' + backupFile);
    cleanOldBackups();
    return backupFile;
  } catch (err) {
    console.error('  Backup error:', err.message);
    return null;
  }
}

function backupIfNeeded(minIntervalMinutes) {
  const minInterval = (minIntervalMinutes || 5) * 60 * 1000;
  if (Date.now() - lastBackupTime > minInterval) {
    return createBackup();
  }
  return null;
}

function cleanOldBackups() {
  try {
    const files = fs.readdirSync(backupDir)
      .filter(f => f.startsWith('database_') && f.endsWith('.sqlite'))
      .map(f => ({ name: f, time: fs.statSync(path.join(backupDir, f)).mtimeMs }))
      .sort((a, b) => b.time - a.time);
    if (files.length > MAX_BACKUPS) {
      files.slice(MAX_BACKUPS).forEach(f => {
        fs.unlinkSync(path.join(backupDir, f.name));
      });
    }
  } catch (err) {
    console.error('  Backup cleanup error:', err.message);
  }
}

function listBackups() {
  try {
    if (!fs.existsSync(backupDir)) return [];
    return fs.readdirSync(backupDir)
      .filter(f => f.startsWith('database_') && f.endsWith('.sqlite'))
      .map(f => {
        const stat = fs.statSync(path.join(backupDir, f));
        const sizeMB = (stat.size / (1024 * 1024)).toFixed(2);
        const time = new Date(stat.mtime).toLocaleString('es-CL');
        return { file: f, size: sizeMB + ' MB', date: time };
      })
      .sort((a, b) => b.file.localeCompare(a.file));
  } catch { return []; }
}

function startAutoBackup(intervalMinutes) {
  const minutes = intervalMinutes || 30;
  createBackup();
  setInterval(createBackup, minutes * 60 * 1000);
  console.log('  Backup automático cada ' + minutes + ' min (máx ' + MAX_BACKUPS + ' archivos)');
}

module.exports = { createBackup, backupIfNeeded, listBackups, startAutoBackup };
