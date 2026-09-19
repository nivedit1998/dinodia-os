(function () {
  "use strict";
  function reconcile(target, next) {
    Object.assign(target, next);
    return target;
  }
  window.DinodiaStore = { reconcile };
}());
