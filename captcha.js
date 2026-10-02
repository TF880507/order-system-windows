const crypto = require('crypto');

function createCaptchaAnswer(randomInt = crypto.randomInt) {
  return String(randomInt(0, 100000)).padStart(5, '0');
}

function hashCaptcha(id, answer, secret) {
  return crypto.createHmac('sha256', secret).update(`${id}:${answer}`).digest('hex');
}

function captchaMatches(actualHash, id, answer, secret) {
  const expected = Buffer.from(hashCaptcha(id, answer, secret), 'hex');
  const actual = Buffer.from(String(actualHash || ''), 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function buildCaptchaSvg(answer, randomInt = crypto.randomInt) {
  const colors = ['#24324a', '#6f3c8f', '#136b6a', '#8a3d34', '#36559b'];
  const digits = [...String(answer)].map((digit, index) => {
    const x = 28 + index * 38 + randomInt(-3, 4);
    const y = 52 + randomInt(-5, 6);
    const rotate = randomInt(-16, 17);
    return `<text x="${x}" y="${y}" fill="${colors[index % colors.length]}" transform="rotate(${rotate} ${x} ${y})">${digit}</text>`;
  }).join('');
  const lines = Array.from({ length:4 }, (_, index) => {
    const y1 = 10 + index * 15 + randomInt(-4, 5);
    const y2 = 16 + index * 12 + randomInt(-5, 6);
    return `<path d="M4 ${y1} C60 ${y2 - 14},140 ${y2 + 14},216 ${y2}" />`;
  }).join('');
  const dots = Array.from({ length:26 }, () => `<circle cx="${randomInt(5, 216)}" cy="${randomInt(5, 66)}" r="${randomInt(1, 3)}" />`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="72" viewBox="0 0 220 72" role="img" aria-label="五位數登入驗證碼"><rect width="220" height="72" rx="8" fill="#f5f7fb"/><g fill="#aeb8ca" opacity=".55">${dots}</g><g fill="none" stroke="#8f9bb1" stroke-width="1.5" opacity=".55">${lines}</g><g font-family="Arial,sans-serif" font-size="42" font-weight="700">${digits}</g></svg>`;
}

function captchaDataUrl(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

module.exports = { createCaptchaAnswer, hashCaptcha, captchaMatches, buildCaptchaSvg, captchaDataUrl };
