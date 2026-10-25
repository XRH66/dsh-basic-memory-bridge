import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeTools, mcpResult } from './helpers.js';

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '') || 'note';
}

/**
 * Small in-memory Basic Memory double: notes keep their body, frontmatter,
 * vault-relative path and optimistic checksum. Only the tool surface the bridge
 * uses is implemented.
 */
export function memoryStore({ vault = null } = {}) {
  const notes = new Map();
  let seq = 0;
  const filePathOf = (permalink) => {
    if (!permalink) return '';
    return permalink.replace(/^personal\//, '') + '.md';
  };
  const find = (identifier) => {
    const raw = String(identifier ?? '');
    const direct = notes.get(raw) || notes.get(raw.replace(/^personal\//, ''));
    if (direct) return direct;
    const byTitle = [...notes.values()].filter((note) => note.title === raw);
    return byTitle.length === 1 ? byTitle[0] : undefined;
  };
  const bump = () => 'c' + (++seq);
  const tools = fakeTools(async (input) => {
    const args = input.arguments ?? {};
    if (input.name === 'mcp__basic_memory__list_directory') {
      const dir = String(args.dir_name ?? '').replace(/\/+$/, '');
      const nodes = [];
      for (const note of notes.values()) {
        const relative = note.permalink.replace(/^personal\//, '');
        if (!relative.startsWith(dir + '/')) continue;
        const rest = relative.slice(dir.length + 1);
        if (rest.includes('/')) continue;
        nodes.push({ type: 'file', name: note.title, title: note.title, directory_path: dir, permalink: note.permalink, updated_at: note.updated });
      }
      return mcpResult({ nodes });
    }
    if (input.name === 'mcp__basic_memory__read_note') {
      const note = find(args.identifier);
      if (!note) return mcpResult({ title: null, permalink: null, file_path: null, error: 'NOTE_NOT_FOUND', message: 'not found' });
      return mcpResult({
        title: note.title,
        permalink: note.permalink,
        checksum: note.checksum,
        content: note.content,
        file_path: note.filePath,
        frontmatter: { ...note.frontmatter },
      });
    }
    if (input.name === 'mcp__basic_memory__write_note') {
      const directory = String(args.directory ?? '').replace(/^\/+|\/+$/g, '');
      const permalink = 'personal/' + directory + '/' + slug(args.title);
      const existing = notes.get(permalink);
      if (existing && !args.overwrite) throw new Error('note already exists');
      if (existing && args.expected_checksum && String(args.expected_checksum) !== existing.checksum) {
        return mcpResult({ action: 'conflict', error: 'checksum mismatch' });
      }
      const note = {
        title: String(args.title),
        permalink,
        directory,
        content: String(args.content ?? ''),
        frontmatter: { ...(args.metadata ?? {}) },
        tags: Array.isArray(args.tags) ? [...args.tags] : [],
        checksum: bump(),
        updated: '2026-10-24T04:00:00.000Z',
      };
      note.filePath = filePathOf(permalink);
      notes.set(permalink, note);
      return mcpResult({ title: note.title, permalink, checksum: note.checksum, file_path: note.filePath, action: existing ? 'updated' : 'created' });
    }
    if (input.name === 'mcp__basic_memory__edit_note') {
      const note = find(args.identifier);
      if (!note) return mcpResult({ action: 'conflict', error: 'note not found' });
      if (args.expected_checksum && String(args.expected_checksum) !== note.checksum) {
        return mcpResult({ action: 'conflict', error: 'checksum mismatch' });
      }
      const operation = String(args.operation ?? '');
      const content = String(args.content ?? '');
      const oldH1 = /^#\s+(.+)$/m.exec(note.content)?.[1]?.trim() ?? '';
      if (operation === 'append') {
        if (content) note.content = note.content.replace(/\n*$/, '\n') + content;
      } else if (operation === 'find_replace') {
        const findText = String(args.find_text ?? '');
        const parts = note.content.split(findText);
        if (!findText || parts.length !== 2) {
          return mcpResult({ action: 'conflict', error: parts.length > 2 ? 'multiple matches' : 'no match' });
        }
        note.content = parts[0] + content + parts[1];
      } else if (operation === 'replace_section') {
        const heading = String(args.section ?? '');
        const index = note.content.indexOf(heading);
        if (index < 0) return mcpResult({ action: 'conflict', error: 'no match' });
        note.content = note.content.slice(0, index) + content;
      } else if (operation === 'prepend') {
        note.content = content + note.content;
      } else {
        return mcpResult({ action: 'conflict', error: 'unsupported operation' });
      }
      if (args.metadata && typeof args.metadata === 'object') note.frontmatter = { ...note.frontmatter, ...args.metadata };
      const newH1 = /^#\s+(.+)$/m.exec(note.content)?.[1]?.trim() ?? '';
      if (newH1 && oldH1 && oldH1 === note.title && newH1 !== oldH1) {
        note.title = newH1;
        note.frontmatter.title = newH1;
      }
      note.checksum = bump();
      note.updated = '2026-10-24T04:00:00.000Z';
      return mcpResult({ title: note.title, permalink: note.permalink, checksum: note.checksum, file_path: note.filePath, action: 'updated' });
    }
    if (input.name === 'mcp__basic_memory__delete_note') {
      const note = find(args.identifier);
      if (!note) return mcpResult({ deleted: false });
      notes.delete(note.permalink);
      return mcpResult({ deleted: true });
    }
    if (input.name === 'mcp__basic_memory__move_note') {
      const note = find(args.identifier);
      if (!note) return mcpResult({ error: 'NOTE_NOT_FOUND' });
      const destination = String(args.destination_path ?? '');
      const conflict = [...notes.values()].find((item) => item !== note && item.filePath && item.filePath === destination);
      if (conflict) return mcpResult({ error: 'DESTINATION_EXISTS', moved: false });
      note.directory = path.posix.dirname(destination);
      note.filePath = destination;
      note.checksum = bump();
      return mcpResult({ moved: true, permalink: note.permalink, checksum: note.checksum, file_path: note.filePath });
    }
    if (input.name === 'mcp__basic_memory__search_notes') {
      const tags = Array.isArray(args.tags) ? args.tags : [];
      const query = String(args.query ?? '').toLowerCase();
      const results = [...notes.values()]
        .filter((note) => tags.every((tag) => note.tags.includes(tag)))
        .filter((note) => !query || note.content.toLowerCase().includes(query) || note.title.toLowerCase().includes(query) || query.split(/\s+/).some((part) => part.length > 1 && note.content.toLowerCase().includes(part)))
        .map((note) => ({ title: note.title, permalink: note.permalink, score: 1, matched_chunk: note.content }));
      return mcpResult({ results });
    }
    throw new Error('unexpected tool ' + input.name);
  });
  return { tools, notes };
}

export async function makeVault() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'dafeiyu-memory-'));
}
