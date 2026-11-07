import assert from 'node:assert/strict';
import test from 'node:test';
import { ImageCache } from './imageCache';

test('ImageCache stores and retrieves images by turnId and index', () => {
	const cache = new ImageCache(3);
	cache.set('turn-1', 0, { data: 'base64-1', mimeType: 'image/jpeg', name: 'img1.jpg' });
	cache.set('turn-1', 1, { data: 'base64-2', mimeType: 'image/png', name: 'img2.png' });

	assert.strictEqual(cache.size, 2);
	const retrieved = cache.get('turn-1', 0);
	assert.ok(retrieved);
	assert.strictEqual(retrieved?.data, 'base64-1');
	assert.strictEqual(retrieved?.mimeType, 'image/jpeg');
	assert.strictEqual(retrieved?.name, 'img1.jpg');

	const byTurn = cache.getByTurn('turn-1');
	assert.strictEqual(byTurn.length, 2);
	assert.strictEqual(byTurn[0].index, 0);
	assert.strictEqual(byTurn[1].index, 1);
});

test('ImageCache evicts least-recently used image when capacity is reached', () => {
	const cache = new ImageCache(3);
	cache.set('turn-1', 0, { data: 'img-1', mimeType: 'image/jpeg' });
	cache.set('turn-2', 0, { data: 'img-2', mimeType: 'image/jpeg' });
	cache.set('turn-3', 0, { data: 'img-3', mimeType: 'image/jpeg' });

	// Access img-1 to make it recently used
	cache.get('turn-1', 0);

	// Add 4th image -> turn-2 should be evicted (as turn-1 was recently accessed)
	cache.set('turn-4', 0, { data: 'img-4', mimeType: 'image/jpeg' });

	assert.strictEqual(cache.size, 3);
	assert.strictEqual(cache.has('turn-1', 0), true);
	assert.strictEqual(cache.has('turn-2', 0), false); // Evicted!
	assert.strictEqual(cache.has('turn-3', 0), true);
	assert.strictEqual(cache.has('turn-4', 0), true);
});

test('ImageCache handles empty / cold cache without errors', () => {
	const cache = new ImageCache(5);
	assert.strictEqual(cache.size, 0);
	assert.strictEqual(cache.get('nonexistent', 0), undefined);
	assert.deepStrictEqual(cache.getByTurn('nonexistent'), []);
	assert.strictEqual(cache.has('nonexistent'), false);

	cache.clear();
	assert.strictEqual(cache.size, 0);
});
