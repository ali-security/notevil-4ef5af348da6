var names = ['Object', 'String', 'Boolean', 'Number', 'RegExp', 'Date', 'Array', 'Function']
var immutable = {string: 'String', boolean: 'Boolean', number: 'Number' }

var primitives = names.map(getGlobal)
var protos = primitives.map(getProto)

var protoReplacements = {}

// built-in objects shared with the host that must never be modified from inside the sandbox
var builtins = primitives.concat(protos)
var otherBuiltins = ['Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError',
  'Symbol', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Proxy', 'Reflect', 'Math', 'JSON']
otherBuiltins.forEach(function(name){
  var value = global[name]
  if (value){
    builtins.push(value)
    if (value.prototype) builtins.push(value.prototype)
  }
})
;[[], ''].forEach(function(value){ // iterator prototypes
  var iterator = typeof Symbol === 'function' && Symbol.iterator && value[Symbol.iterator]
  if (typeof iterator === 'function'){
    var proto = Object.getPrototypeOf(iterator.call(value))
    builtins.push(proto, Object.getPrototypeOf(proto))
  }
})

// reflective functions that modify the object they are given, replaced inside
// the sandbox with versions that refuse to modify built-in objects
var mutators = []
var mutatorGuards = []

;['defineProperty', 'defineProperties', 'setPrototypeOf', 'assign', 'freeze', 'seal', 'preventExtensions'].forEach(function(name){
  addMutator(Object[name], targetArgument)
})
if (typeof Reflect === 'object' && Reflect){
  ['defineProperty', 'deleteProperty', 'set', 'setPrototypeOf', 'preventExtensions'].forEach(function(name){
    addMutator(Reflect[name], targetArgument)
  })
}
addMutator(Error.captureStackTrace, targetArgument)
addMutator(Object.prototype.__defineGetter__, targetReceiver)
addMutator(Object.prototype.__defineSetter__, targetReceiver)
addMutator(protoAccessor('set'), targetReceiver)
;['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin'].forEach(function(name){
  addMutator(Array.prototype[name], targetReceiver)
})

// reflective functions that can return built-in objects, replaced inside the
// sandbox with versions that return the sandboxed replacements instead
var inspectors = []
var inspectorFactories = []

addInspector(Object.getPrototypeOf, guardPrototypeOf)
addInspector(typeof Reflect === 'object' && Reflect && Reflect.getPrototypeOf, guardPrototypeOf)
addInspector(protoAccessor('get'), function(original, primitives){
  return function(){
    'use strict'
    return primitives.mapPrototype(this, original.apply(this, arguments))
  }
})
addInspector(Object.getOwnPropertyDescriptor, guardDescriptor)
addInspector(typeof Reflect === 'object' && Reflect && Reflect.getOwnPropertyDescriptor, guardDescriptor)
addInspector(Object.getOwnPropertyDescriptors, function(original, primitives){
  return function(){
    'use strict'
    var descriptors = original.apply(this, arguments)
    for (var key in descriptors){
      descriptors[key] = primitives.sanitizeDescriptor(descriptors[key])
    }
    return descriptors
  }
})
addInspector(Object.prototype.__lookupGetter__, guardResult)
addInspector(Object.prototype.__lookupSetter__, guardResult)

module.exports = Primitives

function Primitives(context, safeFunction){
  if (this instanceof Primitives){
    this.context = context
    this.safeFunction = safeFunction
    this.replacements = []
    for (var i=0;i<names.length;i++){
      if (!this.context[names[i]]){
        // the sandboxed Function constructor creates sandboxed functions
        var impl = primitives[i] === Function ? safeFunction : null
        this.context[names[i]] = wrap(primitives[i], impl)
      }
      // keep the replacements even if sandboxed code later shadows the names
      this.replacements[i] = this.context[names[i]]
    }
  } else {
    return new Primitives(context, safeFunction)
  }
}

Primitives.prototype.replace = function(value){
  var primIndex = primitives.indexOf(value)
  var protoIndex = protos.indexOf(value)

  if (~primIndex){
    return this.replacements[primIndex]
  } else if (~protoIndex) {
    var ctor = this.replacements[protoIndex]
    return ctor == null ? undefined : ctor.prototype
  } else  {
    return value
  }
}

// make a value safe to hand to sandboxed code: built-in objects are replaced
// with their sandboxed versions and dangerous reflective functions are guarded
Primitives.prototype.sanitize = function(value){
  // the real Function is replaced with the sandboxed Function constructor
  value = this.replace(value)
  if (value === Function && this.safeFunction){
    // the context provided the real Function constructor
    return this.safeFunction
  }
  return this.guard(value)
}

Primitives.prototype.sanitizeDescriptor = function(descriptor){
  if (descriptor){
    if ('value' in descriptor) descriptor.value = this.sanitize(descriptor.value)
    if (descriptor.get) descriptor.get = this.sanitize(descriptor.get)
    if (descriptor.set) descriptor.set = this.sanitize(descriptor.set)
  }
  return descriptor
}

Primitives.prototype.guard = function(value){
  if (typeof value !== 'function'){
    return value
  }
  var index = mutators.indexOf(value)
  if (~index){
    return mutatorGuards[index]
  }
  index = inspectors.indexOf(value)
  if (~index){
    var guards = this.inspectorGuards || (this.inspectorGuards = [])
    return guards[index] || (guards[index] = inspectorFactories[index](value, this))
  }
  return value
}

// determine if a value is a built-in object shared with the host
Primitives.prototype.isProtected = function(value){
  return isProtected(value)
}

// resolve `value.__proto__` without exposing the real built-in prototypes
Primitives.prototype.getProtoProperty = function(value){
  var object = Object(value)
  var proto = Object.getPrototypeOf(object)
  var result = object['__proto__']
  return result === proto ? this.mapPrototype(value, proto) : result
}

// map the real prototype of value to the one seen from inside the sandbox
Primitives.prototype.mapPrototype = function(value, proto){
  var replacement = this.replace(proto)
  while (replacement === value && proto != null){
    // value is a sandboxed replacement itself, so skip its real counterpart
    proto = Object.getPrototypeOf(proto)
    replacement = this.replace(proto)
  }
  return replacement
}

Primitives.prototype.getPropertyObject = function(object, property){
  if (immutable[typeof object]){
    return this.getPrototypeOf(object)
  }
  return object
}

Primitives.prototype.isPrimitive = function(value){
  return !!~primitives.indexOf(value) || !!~protos.indexOf(value)
}

Primitives.prototype.getPrototypeOf = function(value){
  if (value == null){ // handle null and undefined
    return value
  }

  var immutableType = immutable[typeof value]
  if (immutableType){
    var proto = this.context[immutableType].prototype
  } else {
    var proto = Object.getPrototypeOf(value)
  }

  if (!proto || proto === Object.prototype){
    return null
  } else {
    var replacement = this.replace(proto)
    if (replacement === value){
      replacement = this.replace(Object.prototype)
    }
    return replacement
  }
}

Primitives.prototype.applyNew = function(func, args){
  if (isFunctionConstructor(func) && func !== Function){
    // the sandboxed Function constructor only creates sandboxed functions
    return func.apply(null, args)
  } else if (func.wrapped){
    var prim = Object.getPrototypeOf(func)
    var instance = new (Function.prototype.bind.apply(prim, arguments))
    setProto(instance, func.prototype)
    return instance
  } else {
    return new (Function.prototype.bind.apply(func, arguments))
  }
}

function getProto(func){
  return func.prototype
}

function getGlobal(str){
  return global[str]
}

function setProto(obj, proto){
  obj.__proto__ = proto
}

function isProtected(value){
  return value != null && !!~builtins.indexOf(value)
}

function isFunctionConstructor(value){
  return value === Function || (typeof value === 'function' &&
    Object.getPrototypeOf(value) === Function && value.wrapped === true)
}

function protoAccessor(kind){
  var descriptor = Object.getOwnPropertyDescriptor(Object.prototype, '__proto__')
  return descriptor && descriptor[kind]
}

function targetArgument(self, args){
  return args[0]
}

function targetReceiver(self, args){
  return self
}

function addMutator(original, getTarget){
  if (typeof original !== 'function' || ~mutators.indexOf(original)) return
  mutators.push(original)
  mutatorGuards.push(function(){
    'use strict'
    if (isProtected(getTarget(this, arguments))){
      throw new TypeError('Cannot modify built-in objects from inside the sandbox')
    }
    return original.apply(this, arguments)
  })
}

function addInspector(original, factory){
  if (typeof original !== 'function' || ~inspectors.indexOf(original)) return
  inspectors.push(original)
  inspectorFactories.push(factory)
}

function guardPrototypeOf(original, primitives){
  return function(value){
    'use strict'
    return primitives.mapPrototype(value, original.apply(this, arguments))
  }
}

function guardDescriptor(original, primitives){
  return function(){
    'use strict'
    return primitives.sanitizeDescriptor(original.apply(this, arguments))
  }
}

function guardResult(original, primitives){
  return function(){
    'use strict'
    return primitives.sanitize(original.apply(this, arguments))
  }
}

function wrap(prim, impl){
  var proto = Object.create(prim.prototype)

  var result = function() {
    if (impl){
      return impl.apply(null, arguments)
    } else if (this instanceof result){
      prim.apply(this, arguments)
    } else {
      var instance = prim.apply(null, arguments)
      // don't change the prototype of an existing object passed in (e.g. Object(obj))
      if (instance !== arguments[0]){
        setProto(instance, proto)
      }
      return instance
    }
  }
  setProto(result, prim)
  result.prototype = proto
  result.wrapped = true
  if (impl){
    Object.defineProperty(proto, 'constructor', {value: result, writable: true, configurable: true})
  }
  return result
}