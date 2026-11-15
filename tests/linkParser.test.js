import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTimeValue, parseYouTubeLink, isValidVideoId } from '../js/linkParser.js';

const ID = 'abcDEF_12-3';

test('11자리 ID 단독 입력', () => {
  assert.deepEqual(parseYouTubeLink(ID), { videoId: ID, startSeconds: null });
  assert.deepEqual(parseYouTubeLink(`  ${ID}  `), { videoId: ID, startSeconds: null });
  assert.equal(parseYouTubeLink('abc'), null);
  assert.equal(parseYouTubeLink('abcDEF_12-34'), null); // 12자
});

test('다양한 링크 형식', () => {
  const cases = [
    `https://youtu.be/${ID}`,
    `youtu.be/${ID}`,
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?feature=share&v=${ID}`,
    `https://m.youtube.com/watch?v=${ID}`,
    `www.youtube.com/watch?v=${ID}`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/shorts/${ID}?feature=share`,
    `https://www.youtube.com/embed/${ID}`,
    `https://www.youtube-nocookie.com/embed/${ID}?rel=0`,
    `https://music.youtube.com/watch?v=${ID}&list=RDAMVM${ID}`,
    `https://www.youtube.com/live/${ID}`,
    `http://youtu.be/${ID}?si=xyz`,
  ];
  for (const url of cases) {
    assert.equal(parseYouTubeLink(url)?.videoId, ID, url);
  }
});

test('t 파라미터는 시작 초로 변환', () => {
  assert.equal(parseYouTubeLink(`https://youtu.be/${ID}?t=45`).startSeconds, 45);
  assert.equal(parseYouTubeLink(`https://youtu.be/${ID}?t=45s`).startSeconds, 45);
  assert.equal(parseYouTubeLink(`https://www.youtube.com/watch?v=${ID}&t=1m5s`).startSeconds, 65);
  assert.equal(parseYouTubeLink(`https://www.youtube.com/watch?v=${ID}&t=1h2m3s`).startSeconds, 3723);
  assert.equal(parseYouTubeLink(`https://www.youtube.com/watch?v=${ID}#t=30`).startSeconds, 30);
  assert.equal(parseYouTubeLink(`https://www.youtube.com/embed/${ID}?start=12`).startSeconds, 12);
  assert.equal(parseYouTubeLink(`https://youtu.be/${ID}?t=abc`).startSeconds, null);
  assert.equal(parseYouTubeLink(`https://youtu.be/${ID}`).startSeconds, null);
});

test('parseTimeValue', () => {
  assert.equal(parseTimeValue('90'), 90);
  assert.equal(parseTimeValue('2m'), 120);
  assert.equal(parseTimeValue('1:05'), 65);
  assert.equal(parseTimeValue(''), null);
  assert.equal(parseTimeValue(null), null);
  assert.equal(parseTimeValue('x1'), null);
});

test('잘못된 입력', () => {
  assert.equal(parseYouTubeLink(''), null);
  assert.equal(parseYouTubeLink(null), null);
  assert.equal(parseYouTubeLink('https://example.com/watch?v=' + ID), null);
  assert.equal(parseYouTubeLink('https://www.youtube.com/watch?v=short'), null);
  assert.equal(parseYouTubeLink('https://www.youtube.com/channel/UCxxxxxxxxxx'), null);
  assert.equal(parseYouTubeLink('not a url at all'), null);
  assert.equal(isValidVideoId('VIDEO_ID_1'), false);
});
