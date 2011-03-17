var object = function() {
  this.store = {};
};
object.prototype.set = function(key, val) {
  this.store[key] = val;
};
object.prototype.get = function(key) {
  return this.store[key];
};
object.prototype.delete = function(key) {
  delete this.store[key];
};
object.prototype.do = function(fnExec) {
  for (var i=0,keys=Object.keys(this.store),len=keys.length; i<len; i++)
    fnExec(keys[i], this.store[keys[i]]);
};
module.exports = object;