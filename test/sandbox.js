var safeEval = require('../')
var test = require('tape')

test('attempt override prototype method', function(t){
  var original = Array.prototype.map
  safeEval('Array.prototype.map = function(){ return "HACK" }', {
    Array: Array
  })
  t.equal(Array.prototype.map, original, 'prototype method not changed')
  t.end()
})

test('attempt to set __proto__', function(t){
  var x = ['test']
  var original = Object.getPrototypeOf(x)
  safeEval('x.__proto__ = {newProto: true}', {
    x: original
  })
  t.equal(Object.getPrototypeOf(x), original, '__proto__ not changed')
  t.end()
})

test('try to access this via constructor', function(t){
  var result = safeEval("[].slice.constructor('return this')()")
  t.equal(result, null)
  t.end()
})

test('try to access this via constructor and bind', function(t){
  var result = safeEval("[].slice.constructor.bind()('return this')()")
  t.equal(result, null)
  t.end()
})

test('infinite recursion', function(t){
  t.throws(function(){
    safeEval('function test() { test() }; test()')
  })
  t.end()
})

test('infinite for loop', function(t){
  t.throws(function(){
    safeEval('for (;true;){}')
  })
  t.end()
})

test('infinite while loop', function(t){
  t.throws(function(){
    safeEval('while (true){}')
  })
  t.end()
})

test('set wrapped string prototype', function(t){
  var code = 'String.prototype.makeLouder = function() { return this + "!" }; "test".makeLouder()'
  t.equal(safeEval(code), 'test!')
  t.throws(function(){
    "test".makeLouder()
  }, 'original string prototype untouched')
  t.end()
})

test('set wrapped object prototype', function(t){
  var code = 'Object.prototype.wibblify = function() { return "~" + this.value + "~" }; ({value: "test"}).wibblify()'
  t.equal(safeEval(code), '~test~')
  t.throws(function(){
    ({value: "test"}).wibblify()
  }, 'original object prototype untouched')
  t.end()
})

test('set wrapped object prototype by object.__proto__', function(t){
  var code = '({}).__proto__.wibblify = function() { return "~" + this.value + "~" }; ({value: "test"}).wibblify()'
  t.equal(safeEval(code), '~test~')
  t.throws(function(){
    ({value: "test"}).wibblify()
  }, 'original object prototype untouched')
  t.end()
})

test('prevent access to Function via function call', function(t){
  var code = "" +
    "function fn() {};" +
    "var constructorProperty = Object.getOwnPropertyDescriptors(fn.__proto__).constructor;" +
    "var properties = Object.values(constructorProperty);" +
    "properties.pop();" +
    "properties.pop();" +
    "properties.pop();" +
    "var Function = properties.pop();" +
    "(Function('return this'))()"
  t.notEqual(safeEval(code), global)
  t.equal(safeEval(code), null)
  t.end()
})

test('prevent access to Function via function call (bound)', function(t){
  var code = "" +
    "function fn() {};" +
    "var constructorProperty = Object.getOwnPropertyDescriptors(fn.__proto__).constructor;" +
    "var properties = Object.values(constructorProperty);" +
    "properties.pop();" +
    "properties.pop();" +
    "properties.pop();" +
    "var Func = properties.map(function (x) {return x.bind(x, 'return this')}).pop();" +
    "(Func())()"
  t.notEqual(safeEval(code), global)
  t.equal(safeEval(code), null)
  t.end()
})

test('prevent access to Function prototype', function(t){
  safeEval("try{a[b];}catch(e){e.constructor.constructor('return __proto__.arguments.callee.__proto__.polluted=true')()};")
  t.equal(Function.polluted, undefined)
  t.end()
})

// run code in the sandbox, returning any thrown error instead of throwing
function tryEval(code, context){
  try {
    return safeEval(code, context)
  } catch (ex) {
    return ex
  }
}

function cleanup(object, keys){
  keys.forEach(function(key){
    delete object[key]
  })
}

test('prevent prototype pollution via computed __proto__ (CVE-2021-23771)', function(t){
  tryEval("" +
    "Object.defineProperty(({})[['__proto__']][['__proto__']], 'notevilPoC', {" +
    "  value: 'success'" +
    "});")
  t.equal(Object.prototype.notevilPoC, undefined, 'Object.prototype not polluted')
  t.equal(({}).notevilPoC, undefined, 'new objects not polluted')
  t.end()
})

test('prevent access to built-in prototypes', function(t){
  var cases = [
    [Object.prototype, "({}).__proto__.__proto__"],
    [Object.prototype, "({})['__proto__']['__proto__']"],
    [Object.prototype, "({}).constructor.prototype"],
    [Object.prototype, "Object.getPrototypeOf(Object.getPrototypeOf({}))"],
    [Object.prototype, "Object.getPrototypeOf(Object)"],
    [Array.prototype, "[].constructor.prototype"],
    [Array.prototype, "[].__proto__.__proto__"],
    [String.prototype, "''.constructor.prototype"],
    [String.prototype, "''.__proto__.__proto__"],
    [Number.prototype, "(1).constructor.prototype"],
    [Function.prototype, "(function(){}).__proto__"],
    [Function.prototype, "Object.getPrototypeOf(function(){})"]
  ]
  cases.forEach(function(item){
    var target = item[0]
    tryEval("Object.defineProperty(" + item[1] + ", 'notevilA', {value: 1, configurable: true})")
    tryEval("Object.defineProperties(" + item[1] + ", {notevilB: {value: 1, configurable: true}})")
    tryEval("Object.assign(" + item[1] + ", {notevilC: 1})")
    tryEval(item[1] + ".__defineGetter__('notevilD', function(){ return 1 })")
    tryEval("[].push.call(" + item[1] + ", 'notevilE')")
    t.equal(target.notevilA, undefined, 'defineProperty blocked: ' + item[1])
    t.equal(target.notevilB, undefined, 'defineProperties blocked: ' + item[1])
    t.equal(target.notevilC, undefined, 'assign blocked: ' + item[1])
    t.equal(target.notevilD, undefined, '__defineGetter__ blocked: ' + item[1])
    t.equal(Object.getOwnPropertyDescriptor(target, '0'), undefined, 'push blocked: ' + item[1])
    cleanup(target, ['notevilA', 'notevilB', 'notevilC', 'notevilD', '0'])
    if (Object.getOwnPropertyDescriptor(target, 'length') && target !== Array.prototype && typeof target !== 'function'){
      cleanup(target, ['length'])
    }
  })
  Array.prototype.length = 0
  t.end()
})

test('prevent access to built-in prototypes without reading them directly', function(t){
  tryEval("" +
    "Object.defineProperty.apply(null, [{}].map(Object.getPrototypeOf).map(Object.getPrototypeOf)" +
    "  .concat(['notevilF', {value: 1, configurable: true}]))")
  tryEval("" +
    "var getProto = ({}).__lookupGetter__('__proto__');" +
    "Object.defineProperty(getProto.call(getProto.call({})), 'notevilG', {value: 1, configurable: true})")
  tryEval("" +
    "var getProto = ({}).__lookupGetter__('__proto__');" +
    "Object.assign.apply(null, [{}].map(Function.prototype.call, getProto).map(Function.prototype.call, getProto)" +
    "  .concat([{notevilS: 1}]))")
  t.equal(Object.prototype.notevilF, undefined, 'getPrototypeOf result is not the real prototype')
  t.equal(Object.prototype.notevilG, undefined, '__proto__ getter result is not the real prototype')
  t.equal(Object.prototype.notevilS, undefined, '__proto__ getter result is not the real prototype (point-free)')
  cleanup(Object.prototype, ['notevilF', 'notevilG', 'notevilS'])
  t.end()
})

test('prevent modifying built-ins provided by the context', function(t){
  var context = {Object: Object, Array: Array}
  tryEval("Object.defineProperty(Object.prototype, 'notevilH', {value: 1, configurable: true})", context)
  tryEval("Object.prototype.__defineGetter__('notevilI', function(){ return 1 })", context)
  tryEval("" +
    "Function.prototype.call.apply(Function.prototype.apply," +
    "  Object.values(Object.getOwnPropertyDescriptor(Object, 'defineProperty')).slice(0, 1)" +
    "    .concat([null, [Object.prototype, 'notevilJ', {value: 1, configurable: true}]]))", context)
  tryEval("Object.setPrototypeOf(Array.prototype, {notevilK: 1})", context)
  t.equal(Object.prototype.notevilH, undefined, 'defineProperty blocked')
  t.equal(Object.prototype.notevilI, undefined, '__defineGetter__ blocked')
  t.equal(Object.prototype.notevilJ, undefined, 'defineProperty via descriptor blocked')
  t.equal(Object.getPrototypeOf(Array.prototype), Object.prototype, 'setPrototypeOf blocked')
  Object.setPrototypeOf(Array.prototype, Object.prototype)
  cleanup(Object.prototype, ['notevilH', 'notevilI', 'notevilJ'])
  t.end()
})

test('prevent deleting properties of built-in prototypes', function(t){
  Object.defineProperty(Array.prototype, 'notevilProbe', {value: 1, configurable: true})
  tryEval("delete [].__proto__.__proto__.notevilProbe")
  tryEval("delete Array.prototype.notevilProbe", {Array: Array})
  t.equal(Array.prototype.notevilProbe, 1, 'built-in property not deleted')
  cleanup(Array.prototype, ['notevilProbe'])
  t.end()
})

test('attempt to set __proto__ with a non-string key', function(t){
  var target = {}
  tryEval("x[['__proto__']] = {notevilL: true}", {x: target})
  tryEval("" +
    "var calls = 0;" +
    "var key = {toString: function(){ return calls++ ? '__proto__' : 'safe' }};" +
    "x[key] = {notevilL: true}", {x: target})
  t.equal(Object.getPrototypeOf(target), Object.prototype, '__proto__ not changed')
  t.equal(target.notevilL, undefined)
  t.end()
})

test('prevent changing the prototype of context objects via Object()', function(t){
  var target = {}
  tryEval("Object(o); Object.prototype.notevilM = true", {o: target})
  t.equal(Object.getPrototypeOf(target), Object.prototype, 'prototype not changed')
  t.equal(target.notevilM, undefined)
  t.end()
})

test('prevent access to global via the Function constructor', function(t){
  var codes = [
    "Function('return this')()",
    "new Function('return this')()",
    "Function.prototype.constructor('return this')()",
    "Object.constructor('return this')()",
    "Function.prototype.bind.apply(Function, [null, 'return this'])()()",
    "(function(){" +
    "  var ctors = Object.values(__proto__).filter(function(v){ return v === Function });" +
    "  return Function.prototype.call.apply(Function.prototype.call, ctors.concat([null, 'return this']))()" +
    "})()"
  ]
  codes.forEach(function(code){
    var result = tryEval(code)
    t.notEqual(result, global, code)
    t.ok(result == null || result instanceof Error, code)
  })
  t.end()
})

test('prevent modifying error built-ins', function(t){
  tryEval("try { notDefined } catch (e) { e.__proto__.notevilN = 1 }")
  tryEval("try { notDefined } catch (e) { e.constructor.prototype.notevilO = 1 }")
  tryEval("try { notDefined } catch (e) { e.__proto__.__proto__.notevilP = 1 }")
  tryEval("try { notDefined } catch (e) { e.constructor.__proto__.prepareStackTrace = function(){ return 'pwned' } }")
  tryEval("try { notDefined } catch (e) { Object.defineProperty(e.__proto__.__proto__, 'notevilQ', {value: 1, configurable: true}) }")
  tryEval("try { notDefined } catch (e) { [].push.call(e.__proto__.__proto__, 'notevilR') }")
  var original = {
    referenceError: ReferenceError.prototype.notevilN,
    referenceErrorCtor: ReferenceError.prototype.notevilO,
    error: Error.prototype.notevilP,
    prepareStackTrace: Error.prepareStackTrace,
    defineProperty: Error.prototype.notevilQ,
    push: Error.prototype.length
  }
  cleanup(ReferenceError.prototype, ['notevilN', 'notevilO'])
  cleanup(Error.prototype, ['notevilP', 'notevilQ', '0', 'length'])
  cleanup(Error, ['prepareStackTrace'])
  t.equal(original.referenceError, undefined, 'ReferenceError.prototype not changed')
  t.equal(original.referenceErrorCtor, undefined, 'ReferenceError.prototype not changed via constructor')
  t.equal(original.error, undefined, 'Error.prototype not changed')
  t.equal(original.prepareStackTrace, undefined, 'Error.prepareStackTrace not changed')
  t.equal(original.defineProperty, undefined, 'Error.prototype not changed via defineProperty')
  t.equal(original.push, undefined, 'Error.prototype not changed via push')
  t.end()
})

test('sandboxed built-ins keep working', function(t){
  t.equal(safeEval("Object.defineProperty({}, 'a', {value: 1}).a"), 1)
  t.equal(safeEval("Object.assign({}, {b: 2}).b"), 2)
  t.equal(safeEval("Object.getPrototypeOf([]) === Array.prototype"), true)
  t.equal(safeEval("[].constructor === Array"), true)
  t.equal(safeEval("({}).__proto__ === Object.prototype"), true)
  t.equal(safeEval("Object.getPrototypeOf(Object.getPrototypeOf({}))"), null)
  t.equal(safeEval("var a = [3, 1, 2]; a.sort(); a.push(4); a.join()"), '1,2,3,4')
  t.equal(safeEval("Function('a', 'return a * 2')(21)"), 42)
  t.equal(safeEval("new Function('a', 'return a * 3')(3)"), 9)
  t.equal(safeEval("(function(){}).constructor === Function && Function.prototype.constructor === Function"), true)
  t.equal(safeEval("Function.prototype.call.call(function(){ return this.v }, {v: 5})"), 5)
  t.equal(safeEval("var o = {}; Object.freeze(o); Object.isFrozen(o)"), true)
  t.equal(safeEval("Object.getOwnPropertyDescriptor({c: 3}, 'c').value"), 3)
  t.end()
})
