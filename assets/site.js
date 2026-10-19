/* Pickleball Südbaden e.V. · starter site
   The only script: the "I've played …" chips. Without JavaScript every answer shows. */
(function () {
  var list = document.getElementById('playedList');
  if (!list) return;
  var chips = document.querySelectorAll('[data-played]');
  var hint = document.getElementById('playedHint');
  var hintText = hint ? hint.textContent : '';
  Array.prototype.forEach.call(chips, function (chip) {
    chip.addEventListener('click', function () {
      var on = chip.getAttribute('aria-pressed') !== 'true';
      Array.prototype.forEach.call(chips, function (c) { c.setAttribute('aria-pressed', String(on && c === chip)); });
      Array.prototype.forEach.call(list.children, function (item) {
        item.classList.toggle('is-on', on && item.getAttribute('data-played-a') === chip.getAttribute('data-played'));
      });
      list.classList.toggle('is-filtered', on);
      if (hint) hint.textContent = on ? hint.getAttribute('data-reset') : hintText;
    });
  });
})();
