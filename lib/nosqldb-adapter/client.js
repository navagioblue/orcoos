const utils = require('../utils');
const MongooseError = require('../error/mongooseError');
const { NoSQLConnectionString } = require('./connectionString');
const { LOG_LEVELS, OrcoosMutex } = require('./adapterUtils');
const { ObjectId } = require('bson');
const { TableState, NoSQLError, ErrorCode, CapacityMode } = require("oracle-nosqldb");
const { LRUCache } = require('lru-cache');

const OBJECTID_ENABLED = false;
const OBJECTID_PREFIX = "_obid_";
const MAX_QUERY_RESULTS_LIMIT = 10000;
const MAX_BINDING_NAME = 1000;
const KVID = "kvid";
const T = '$t';             // this is the table alias, most work with 't' but not updates on collection tables, they require '$t'
const DEFAULT_DDL_TIMEOUT = 60000; // 60 seconds
const DEFAULT_TIMEOUT = 60000; // 60 seconds
const DEFAULT_TABLE_LIMITS = {
    mode: CapacityMode.PROVISIONED, // Capacity mode of the table, "ON_DEMAND" or "PROVISIONED"
    readUnits: 50,                  
    writeUnits: 50,                 
    storageGB: 25     
};

/**
 * DB connection object for the rest of the code. 
 * It contains in this.client the handle to Oracle NoSQL DB.
 */
class OrcoosClient {
    /**
     * This gets called during the initial Orcoos connect(connection_string, 
     * options).
     * 
     * Available options fields:
     *  - options.prepStmtCacheMax - The maximum number of items that remain in 
     *      the cache. See lru-cache: https://github.com/isaacs/node-lru-cache 
     *      for details.
     *  - options.prepStmtCacheTtl - Max time in milliseconds to live for items
     *      before they are considered stale. See lru-cache:
     *      https://github.com/isaacs/node-lru-cache for details.
     *  - options.logLevel - The level used for logging output: NONE 0, SEVERE: 1, 
     *      WARNING: 2, INFO: 3, CONFIG: 4, FINE: 5, FINNER: 6.
     */
    constructor(uri, options) {
        this.uri = uri;
        this.options = options;
        this.client = null;

        const cacheOptions = {
            // how many max
            max: (options.prepStmtCacheMax ? options.prepStmtCacheMax : 500),
            // how much max storage
            // maxSize: 1000 * 10, // 10k
            // sizeCalculation: (value, key) => {
            //     return 1;
            // },
            // how long to live in ms
            ttl: (options.prepStmtCacheTtl ? options.prepStmtCacheTtl : 1000 * 60 * 10), // 10 min
            // return stale items before removing from cache?
            allowStale: false,
            updateAgeOnGet: true,
            updateAgeOnHas: false,

            // for use when you need to clean up something when objects
            // are evicted from the cache
            // dispose: (value, key) => {
            //     value.close();
            // },
        };

        this.prepStmtCache = new LRUCache(cacheOptions);
    }

    db(dbName) {
        return new OrcoosDb(this, this.options, dbName);
    }
    
    useDb(dbName, options) {
        return new OrcoosDb(this, options, dbName);
    }
    
    setMaxListeners(max) { }

    on(event, f) { }

    /**
     * Connect to the store.
     */
    async connect() {
        this.connectionString = new NoSQLConnectionString(this.uri);
        this.client = await this.connectionString.getClient(this.options);
    }

    /**
     * Close the connection to the store.
     */
    async close() {
        this.connectionString = undefined;
        await this.client.close();
    }
}

/**
 * The Database object, in the DB is implemented as a namespace/compartment.
 */
class OrcoosDb {
    _collections = {};
    constructor(orcoosClient, options, dbName) {
        this.orcoosClient = orcoosClient;
        this.client = orcoosClient.client;
        this.prepStmtCache = orcoosClient.prepStmtCache;
        this.options = options;
        this.dbName = dbName;
    }
    
    /**
     * Returns the object representing the collection @param colName.
     */
    collection(colName) {
        let col = this._collections[colName];
        if (!col) {
            col = new OrcoosCollection(this, colName);
            this._collections[colName] = col;
        }
        return col;
    }
    
    /**
     * Creates a collection @param colName if it doesn't alreay exist.
     */
    async createCollection(colName, options) {
        let col = this.collection(colName);
        if (col._created) {
            return col;
        }
        
        await col._checkTableIsCreated(options);
        return col;
    }
}

/**
 * The Collection object, in DB is implmented as a collection table 
 *  - kvid as a primary key STRING or fields of composite key if _id has multiple fields
 *  - JSON document that contains the non-key data
 */
class OrcoosCollection {
    colName;
    _created = false;
    _hasCompositeKeys = false;
    _primaryKeyList = [KVID];
    _shardKeyList = [KVID];
    _lock = new OrcoosMutex();
    _options;
    
    constructor(db, colName) {
        this.db = db;
        this.colName = colName;
        this._created = false;
    }

    /**
     * Checks if table is already created and creates it if necessary.
     */
    async _checkTableIsCreated(options) {
        await this._lock.acquire();
        try {
            // save rest of options
            let compartment = options?._schema?.options?.collectionOptions?.compartment || this.db.dbName;
            let definedTags = options?._schema?.options?.collectionOptions?.definedTags;
            let freeFormTags = options?._schema?.options?.collectionOptions?.freeFormTags;
            let namespace = options?._schema?.options?.collectionOptions?.namespace || this.db.dbName;
            let tableLimits = options?._schema?.options?.collectionOptions?.tableLimits || DEFAULT_TABLE_LIMITS;
            let ddlTimeout = options?._schema?.options?.collectionOptions?.timeout || DEFAULT_DDL_TIMEOUT;
            let timeout = options?._schema?.options?.collectionOptions?.timeout || DEFAULT_TIMEOUT;
            let durability = options?._schema?.options?.collectionOptions?.durability;
            let consistency = options?._schema?.options?.collectionOptions?.consistency;
            this._options = {
                complete: true,
                ...compartment && {compartment},
                ...definedTags && {definedTags},
                ...freeFormTags && {freeFormTags},
                ...namespace && {namespace},
                ...tableLimits && {tableLimits},
                ...timeout && {timeout},
                ...ddlTimeout && {ddlTimeout},
                ...durability && {durability},
                ...consistency && {consistency}
            }
            let tableName = this.colName;
            try {
                let table = await this.db.client.getTable(tableName, {...this._options});
                if (table && table.tableState == TableState.ACTIVE) {
                    this._created = true;
                    let tableSchema = JSON.parse(table.schema);
                    let pkList = tableSchema.primaryKey;
                    this._hasCompositeKeys = pkList?.length > 1;
                    this._primaryKeyList = pkList;
                    this._shardKeyList = tableSchema.shardKey;
                    return;
                } else {
                    this.log(LOG_LEVELS.FINNER, "     o OCol.createTable() Table " + 
                        (this._options?.namespace ? this._options.namespace + ':': '') + tableName + " does't exist.");
                }
            } catch (e) {
                // ignore NoSQLError TABLE_NOT_FOUND
                if (!(e instanceof NoSQLError && e.errorCode === ErrorCode.TABLE_NOT_FOUND)) {
                    this.log(LOG_LEVELS.SEVERE, "client.getTable error: " + e);
                    throw e;
                }
            }

            if (options?._schema?.options?.autoCreate == false) {
                return;
            }

            // Create the table since it doesn't exist 
            let stmt =  
                'CREATE TABLE IF NOT EXISTS ' + tableName + '(' + KVID + 
                    ' STRING, PRIMARY KEY(' + KVID + ')) AS JSON COLLECTION';
            
            // check for composite key in the schema
            if (options && options._schema && typeof options._schema?.obj._id === 'object' && 
                Object.keys(options._schema?.obj._id).length > 1) {
                // if composite keys defined in the schema
                let keys = Object.keys(options._schema.obj._id);
                let nonKeyFields = Object.keys(options._schema.obj).filter(v => v !== '_id').map(v => v.toLowerCase());
                let allKeyTypesAreValid = true;
                let keySchema = [];
                for (let key of keys) {
                    if (typeof options._schema.obj._id[key] === 'function' &&  
                        (options._schema.obj._id[key].name === 'String' ||
                        options._schema.obj._id[key].name === 'Number' || 
                        options._schema.obj._id[key].name === 'Date')) {
                        let keyType = options._schema.obj._id[key].name;
                        if (keyType === 'Date') {
                            // convert type to String if keytype is Date
                            keyType = 'String';
                        }
                        let isShardKey = options._schema.options?.collectionOptions?.shardKey?.includes(key);
                        keySchema.push({name: key, type: keyType, shardKey: isShardKey});
                    } else {
                        allKeyTypesAreValid = false;
                        break;
                    }
                    // check if any key field colides with non-key fields
                    if (nonKeyFields.includes(key.toLowerCase())) {
                        throw new MongooseError('Composite key and non-key field name collision: "' + key + '"');
                    }
                }
                if (keySchema.filter(k => k.shardKey).length == 0) {
                    // if none was specified as shard it means all of them are shard keys
                    keySchema.forEach(k => {k.shardKey = true });
                }
                if (allKeyTypesAreValid) {
                    this._hasCompositeKeys = true;
                    this._pkSchema = keySchema;
                    let keyDef = '';
                    for (let key of keySchema) {
                        keyDef += key.name + ' ' + key.type + ', ';
                    }
                    this._primaryKeyList = keySchema.map(v => v.name);
                    this._shardKeyList = keySchema.filter(k => k.shardKey).map(sk => sk.name);
                    let shardKeyDef = 'SHARD(' + this._shardKeyList.join(', ') + ')';
                    let nonShardKeyList = keySchema.filter(k => !k.shardKey).map(sk => sk.name);
                    let primaryKeyDef = 'PRIMARY KEY(' + shardKeyDef + 
                        ( nonShardKeyList.length > 0 ? ', ' + nonShardKeyList.join(', ') : '' ) + 
                        ')';
                    
                    stmt = 'CREATE TABLE IF NOT EXISTS ' + tableName + '(' + keyDef + 
                        primaryKeyDef + ') AS JSON COLLECTION';
                } else {
                    throw new MongooseError('Invalid composite key for table: ' + tableName);
                }
            } else {
                this.log(LOG_LEVELS.FINNER, "Standard one component key _id detected.");
            }

            try {
                this.log(LOG_LEVELS.FINE , ' DDL: ' + stmt);
                this.log(LOG_LEVELS.FINNER, JSON.stringify(this._options));
                let result = await this.db.client.tableDDL(stmt, {...this._options});
                await this.db.client.forCompletion(result);
                this._created = true;
                return;
            } catch (e) {
                this.log(LOG_LEVELS.SEVERE, "Error create table: " + tableName + ' error: ' + e);
                throw e;
            }
        } finally {
            await this._lock.release();
        }
    }
    
    /**
     * Inserts one document into the collection. 
     */
    async insertOne(obj, options) {
        try {
            await this._checkTableIsCreated(options);
            let row = this._marshallObjectIntoRow(obj);
            let r = await this.db.client.put(this.colName, row, this._options);
            return { acknoledged: r.success, insertedId: obj._id };
        } catch (e) {
            throw new Error("Error insertOne: " + e);
        }
    }

    /**
     * Translates a Mongoose object @param obj into the row to be stored in the NoSQL store. 
     */
    _marshallObjectIntoRow(obj) {
        let row = {};
        row = this._setPK(row, obj);
        delete obj._id;
        row = Object.assign(row, OrcoosCollection._fixTypesBeforeInsert(obj));
        return row;
    }

    /**
     * Translates the _id of @param obj into the @param row .
     */
    _setPK(row, obj) {
        // must rearange the key fields
        if (this._hasCompositeKeys) {
            row = {...obj._id};
        } else {
            let kvid = "" + obj._id;
            row[KVID] = kvid;
        }
        return row;
    }
    
    /** 
     * MongoDB accepts ObjectId inside doc to be inserted in DB,
     * these ObjectId values are saved in NoSQL DB as their string representation.
     * Ideally they would make it back the same way when reading from the store.
     */
    static _fixTypesBeforeInsert(obj) {
        if (!obj) {
            return obj;
        }
        
        if (obj instanceof ObjectId) {
            return (OBJECTID_ENABLED ? OBJECTID_PREFIX : "" ) + obj;
        } else if (obj instanceof Date) {
            return obj.toISOString();
        }

        if (obj instanceof Array) {
            for (let i in obj) {
                obj[i] = OrcoosCollection._fixTypesBeforeInsert(obj[i]);
            }
            return obj;
        }
        if (obj instanceof Object) {
            for (let prop in obj) {
                obj[prop] = OrcoosCollection._fixTypesBeforeInsert(obj[prop]);
            }
            return obj;
        }
        return obj;
    }
    
    /**
     * If ensbled, transforms back the ObjectId values when read from the store.
     */
    static _fixTypesAfterRead(obj) {
        if (!OBJECTID_ENABLED) {
            if (obj && obj._id && typeof obj._id === 'string') {
                obj._id = new ObjectId(obj._id); 
                return obj;
            }
        }
        
        if (!obj) {
            return obj;
        }
        if (typeof obj === 'string' || obj instanceof String) {
            if ( obj.startsWith(OBJECTID_PREFIX) ) {
                return new ObjectId(obj.substring(OBJECTID_PREFIX.length));
            }
            return obj;
        }
        if (obj instanceof Array) {
            for (let i in obj) {
                obj[i] = OrcoosCollection._fixTypesAfterRead(obj[i]);
            }
            return obj;
        }
        if (obj instanceof Object) {
            for (let prop in obj) {
                obj[prop] = OrcoosCollection._fixTypesAfterRead(obj[prop]);
            }
            return obj;
        }
        return obj;
    }
    
    /**
     * Queries the store and returns one document, the result is not garanted 
     * to be the same if the result contains more than one row and sort is not 
     * used appropiatelly. 
     */
    async findOne(conditions, options) {
        if (conditions._id) {
            await this._checkTableIsCreated(options);
            let row = this._setPK({}, conditions);
            return this.db.client.get(this.colName, row, this._options)
                .then((r) => {
                    if (r && r.row) {
                        return OrcoosCollection._unmarshalObjectFromRow(r.row);
                    } else {
                        return null;
                    }
                });
        }
        
        // Do a regular query and return only one result
        let bindings = {};
        let where = this._computeWhere(conditions, bindings);
        let stmt = 'SELECT * FROM ' + this.colName + ' ' + T + where;
        stmt += this._computeSortClause(options?.sort);
        stmt += this._computeLimitClause(options?.limit || 1, bindings);
        stmt += this._computeOffsetClause(options?.skip, bindings);
        stmt = this._computeBindingsClause(bindings) + stmt;

        this.log(LOG_LEVELS.INFO, " Q: " + stmt);

        await this._checkTableIsCreated(options);
        for await (const batch of this.db.client.queryIterable(stmt, this._options)) {
            if (batch && batch.rows && batch.rows.length > 0)
                return OrcoosCollection._unmarshalObjectFromRow(batch.rows[0]);
        }
        
        return null;
    }

    /**
     * Translates @param row into the coresponding Mongoose object. 
     */
    static _unmarshalObjectFromRow(row) {
        // move key fields under _id
        let obj = row;
        if (this._hasCompositeKeys) {
            for (f of this._pkList) {
                obj._id[f] = r.row[f];
                delete obj[f];
            }
        } else {
            if (OBJECTID_ENABLED) {
                obj._id = new ObjectId(row[KVID]);
            } else {
                obj._id = row[KVID];
            }
            delete obj[KVID];
        }
        return obj;
    }
    
    /**
     * Deletes one document from the collection only if primary key is specified.
     */
    async deleteOne(where, options) {
        if (where._id) {
            await this._checkTableIsCreated(options);
            let pk = this._setPK({}, where);
            return this.db.client.delete(this.colName, pk, this._options)
                .then((r, e) => r.success);
        }
        throw new Error("deleteOne() 'where' param must contain _id field.");
    }
    
    /**
     * Executes UPDATE and DELETE statements.
     */
    async _queryPromise(client, stmt, bindings, options, maxLimit = MAX_QUERY_RESULTS_LIMIT) {        
        try {
            await this._checkTableIsCreated(options);

            let prepStmt = this.db.prepStmtCache.get(stmt);
            if (!prepStmt) {
                prepStmt = await this.db.client.prepare(stmt, this._options);
                this.db.prepStmtCache.set(stmt, prepStmt);
            }
            if (bindings && Object.keys(bindings).length > 0) {
                prepStmt = await prepStmt.copyStatement();
                for (let binding in bindings) {
                    prepStmt.set('$' + binding, this.bindings[binding]);
                }
            }

            let gen = client.queryIterable(prepStmt, this._options);
            let rows = [];
            let count = 0;
            for await (const b of gen) {
                if (count + b.rows.length > maxLimit) {
                    throw new Error("Query results more than maxLimit: " + (count + b.rows.length));
                }
                rows.push(b.rows.map(r => OrcoosCollection._unmarshalObjectFromRow(OrcoosCollection._fixTypesAfterRead(r))));
                count += b.rows.length;
            }

            return [].concat(...rows);
        } catch(err) {
            throw new Error("Error executing query: " + err);
        }
    }
    
    /**
     * Deletes many documents from the collection. 
     */
    async deleteMany(filter, options) {
        let bindings = undefined; // DELETE doesn't accept bindings
        let where = this._computeWhere(filter, bindings);
        let stmt = 'DELETE FROM ' + this.colName + ' ' + T + where;       
        stmt = this._computeBindingsClause(bindings) + stmt;

        try {               
            this.log(LOG_LEVELS.INFO, " Q: " + stmt);
            await this._checkTableIsCreated(options);
            let qp = this.db.client.queryIterable(stmt, this._options);
            
            for await (let b of qp) {
                if (b.rows.length > 0) {
                    return b.rows[0]['numRowsDeleted'];
                }
            }
            throw new Error("Error: no response from deleteMany query.");
        } catch(error) {
            throw new Error("Error: deleteMany query: " + error);
        }
    }
    
    /**
     * Returns the count of docuements in the collection. 
     */
    async countDocuments(filter, options) {
        return this.count(filter, options);
    }
    
    /**
     * Returns the count of docuements in the collection. 
     */
    async count(filter, options) {
        let bindings = {};
        let where = this._computeWhere(filter, bindings);
        let stmt = 'SELECT count(*) FROM ' + this.colName + ' ' + T + where;
        stmt += this._computeLimitClause(options?.limit, bindings);
        stmt += this._computeOffsetClause(options?.skip, bindings);
        stmt = this._computeBindingsClause(bindings) + stmt;

        await this._checkTableIsCreated(options);
        this.log(LOG_LEVELS.INFO, " Q: " + stmt);
        let qp = this.db.client.queryIterable(stmt, this._options);
        
        for await (let b of qp) {
            if (b.rows.length > 0) {
                return b.rows[0]['Column_1'];
            }
        }
        throw new Error("Error: no response from count query.");
    }
    
    /**
     * Updates a document according to the @param update. If the filter doesn't
     * specify the _id it throws an error.
     */
    async updateOne(filter, update, options) {
        // https://www.mongodb.com/docs/manual/reference/method/db.collection.updateOne/#mongodb-method-db.collection.updateOne
        
        if (filter && filter._id) {
            await this._checkTableIsCreated(options);

            let updateClause = this._computeUpdateClause(update);
            let bindings = undefined; // UPDATE doesn't accept bindings
            let where = this._computeWhere(filter, bindings);
            let stmt = 'UPDATE ' + this.colName + ' AS ' + T + updateClause + where;
            stmt = this._computeBindingsClause(bindings) + stmt;

            this.log(LOG_LEVELS.INFO, " Q: " + stmt);
    
            const r = await this._queryPromise(this.db.client, stmt, bindings, options);
            
            return {
                matchedCount: r[0].NumRowsUpdated,
                modifiedCount: r[0].NumRowsUpdated,                    
                acknoledged: r.success
            };
        } else {
            // doesn't contain _id
            throw new Error("updateOne() filter param doesn't contain _id field.");
        }
    }
    
    /**
     * Updates many documents according to the @param update . 
     */
    async updateMany(filter, update, options) {
        // https://www.mongodb.com/docs/manual/reference/method/db.collection.updateOne/#mongodb-method-db.collection.updateOne

        if (!filter || !filter._id) {
            throw new Error("updateMany() filter param doesn't contain _id field.");
        }

        let updateClause = this._computeUpdateClause(update);
        let bindings = undefined; // UPDATE doesn't accept bindings
        let where = this._computeWhere(filter, bindings);
        let stmt = 'UPDATE ' + this.colName + ' AS ' + T + updateClause + where;
        stmt = this._computeBindingsClause(bindings) + stmt;

        this.log(LOG_LEVELS.INFO, " Q: " + stmt);

        const r = await this._queryPromise(this.db.client, stmt, bindings, options);
        
        return {
            matchedCount: r[0].NumRowsUpdated,
            modifiedCount: r[0].NumRowsUpdated,                    
            acknoledged: r.success
        };
    }
    
    /**
     * Returns the update clause based on the @param update . 
     * Example: { $set: { "a.2": <new value>, "a.10": <new value>, } }
     * 
     *  $currentDate    Sets the value of a field to current date, either as a Date or a Timestamp.
     *  $inc            Increments the value of the field by the specified amount.
     *  $min            Only updates the field if the specified value is less than the existing field value.
     *  $max            Only updates the field if the specified value is greater than the existing field value.
     *  $mul            Multiplies the value of the field by the specified amount.
     *  $rename         Renames a field.
     *  $set            Sets the value of a field in a document.
     *  $setOnInsert    Sets the value of a field if an update results in an insert of a document. Has no effect on update operations that modify existing documents.
     *  $unset          Removes the specified field from a document. 
     */
    _computeUpdateClause(update) {
        let updateClause = "";
        
        // These should be done atomically on the server with an UPDATE query
        for (let key in update) {
            if (key == "$set" && update[key] instanceof Object) {
                for (let setKey in update[key]) {
                    updateClause += ', PUT ' + T + ' ' + this._computeUpdateSetPutProp(setKey, this._computeLiteral(update[key][setKey]));
                }
            } else if (key == "$unset" && update[key] instanceof Object) {
                for (let setKey in update[key]) {
                    updateClause += ', REMOVE ' + this._computeDbProp(setKey);
                }
            } else if (key == "$currentDate" && update[key] instanceof Object) {
                for (let setKey in update[key]) {
                    updateClause += ', SET ' + this._computeDbProp(setKey) + ' = CAST (current_time() AS String)';
                }
            } else if (key == "$inc" && update[key] instanceof Object) {
                for (let setKey in update[key]) {
                    updateClause += ', SET ' + this._computeDbProp(setKey) + ' = ' + this._computeDbProp(setKey) + ' + ' + this._computeLiteral(update[key][setKey]);
                }
            } else if (key == "$min" && update[key] instanceof Object) {
                for (let setKey in update[key]) {
                    updateClause += ', SET ' + this._computeDbProp(setKey) + ' = ' + 
                    'CASE WHEN ' + this._computeLiteral(update[key][setKey]) + ' < ' + this._computeDbProp(setKey) +
                    ' THEN ' + this._computeLiteral(update[key][setKey]) + 
                    ' ELSE ' + this._computeDbProp(setKey) + 
                    ' END';
                }
            } else if (key == "$max" && update[key] instanceof Object) {
                for (let setKey in update[key]) {
                    updateClause += ', SET ' + this._computeDbProp(setKey) + ' = ' + 
                    'CASE WHEN ' + this._computeLiteral(update[key][setKey]) + ' > ' + this._computeDbProp(setKey) +
                    ' THEN ' + this._computeLiteral(update[key][setKey]) +
                    ' ELSE ' + this._computeDbProp(setKey) +
                    ' END';
                }
            } else if (key == "$mul" && update[key] instanceof Object) {
                for (let setKey in update[key]) {
                    updateClause += ', SET ' + this._computeDbProp(setKey) + 
                    ' = ' + this._computeDbProp(setKey) + ' * ' + this._computeLiteral(update[key][setKey]);
                }
            } else if (key == "$rename" && update[key] instanceof Object) {
                for (let setKey in update[key]) {
                    let dbProp = this._computeDbProp(setKey);
                    updateClause += ', PUT ' + this._computeUpdateRenamePutProp(setKey, update[key][setKey], dbProp);
                    updateClause += ', REMOVE ' + dbProp;
                }
            } else {
                throw new Error("Operator '" + key + "' not known.");
            }
        }
        
        if (updateClause.startsWith(",")) {
            updateClause = updateClause.substring(1);
        }
        
        return updateClause;
    }
    
    /**
     * Deletes one document from collection. If _id is not specified an exception is thrown.
     */
    async findOneAndDelete(filter, options) {
        if (filter && filter._id) {
            let bindings = undefined;   // DELETE FROM doesn't accept bindings
            let where = this._computeWhere(filter, bindings);
            let stmt = 'DELETE FROM ' + this.colName + ' ' + T + where + " RETURNING *";
            stmt = this._computeBindingsClause(bindings) + stmt;

            this.log(LOG_LEVELS.INFO, " Q: " + stmt);
            
            const resultObj = await this._queryPromise(this.db.client, stmt, bindings, options);

            return (resultObj && resultObj[0] ? resultObj[0] : null);
        }
        throw new Error("findOneAndDelete() filter param doesn't contain _id field.");
    }
    
    /**
     * Updates one document. If the _id is not specified an exception is thrown. 
     */
    async findOneAndUpdate(filter, update, options) {
        if (filter && filter._id) {
            let bindings = undefined;  // UPDATE doesn't accept bindings
            let where = this._computeWhere(filter, bindings);
            let updateClause = this._computeUpdateClause(update);
            let stmt = 'UPDATE ' + this.colName + ' AS ' + T + updateClause + where + " RETURNING *";
            stmt = this._computeBindingsClause(bindings) + stmt;

            this.log(LOG_LEVELS.INFO, " Q: " + stmt);

            await this._checkTableIsCreated(options);

            const r = await this._queryPromise(this.db.client, stmt, bindings, options);
            let res = {value: (r && r[0] ? r[0] : null),
                       ok: (r && r[0] ? 1 : 0)};

            return (r && r[0] ? r[0] : null);
        }
        throw new Error("findOneAndUpdate() filter param doesn't contain _id field.");
    }
    
    /**
     * Not implemented.
     */
    async distinct(field, query, options) {
        // console.log("    o distinct " + this.colName + " field: " + JSON.stringify(field) + 
        //     " q: " + JSON.stringify(query) + " o: " + JSON.stringify(options));
        
        throw new Error("distinct not implemented");
    }
    
    /**
     * Replaces one docuemnt with another in the collection. If _id is not specified 
     * an error is thrown. 
     */
    async replaceOne(filter, replacement, options) {
        if (!filter || !filter._id) {
            throw new Error("replaceOne() filter param doesn't contain _id field.");
        }
        
        let row = this._setPK({}, filter);
        row = Object.assign(row, OrcoosCollection._fixTypesBeforeInsert(replacement));

        await this._checkTableIsCreated(options);

        let putRes = await this.db.client.putIfPresent(this.colName, row, this._options);

        let mc = putRes.success ? 1 : 0;
        return { 
            acknoledged: putRes.success,
            upsertedId: filter._id, 
            matchedCount: mc, 
            modifiedCount: mc
        };
    }
    
    /**
     * Not implmented.
     */
    aggregate(pipeline, options) {
        // todo: Can we do anything here in a future version?
        // console.log("    o aggregate " + this.colName + " pipeline: " + JSON.stringify(pipeline) + 
        //     " o: " + JSON.stringify(options));
        
        throw new Error("aggregate() not implemented");
    }
    
    /**
     * Executes a NoSQL query @param statement with optional binding variables 
     * in @param options.bindins and a maximum number of rows to return @param options.maxLimit .
     * @param {String} statement - SQL statement using the NoSQL DB SQL syntax.
     * @param {Object} options - optional options: 
     *      - bindings: {Object} - optional (name: value) pairs of query binding variables.
     *      - maxLimit: {Number} - optional maximum number of rows to return. If not specified it will default to {@link MAX_QUERY_RESULTS_LIMIT}.
     */
    async nosqlQuery(statement, options = {}) {
        this.log(LOG_LEVELS.INFO, " nosqlQ: " + statement);
        await this._checkTableIsCreated(options); 
        return new OrcoosFindCursor(this, statement, options?.bindings, options?.maxLimit);
    }

    /**
     * Find documents in collection.
     */
    async find(filter, options, schema) {
        let bindings = {};
        let where = this._computeWhere(filter, bindings);
        let projection = this._conputeProjection(options?.projection, schema);
        let stmt = 'SELECT ' + projection + ' FROM ' + this.colName + ' ' + T + where;
        stmt += this._computeSortClause(options?.sort);
        stmt += this._computeLimitClause(options?.limit, bindings);
        stmt += this._computeOffsetClause(options?.skip, bindings);
        stmt  = this._computeBindingsClause(bindings) + stmt;

        this.log(LOG_LEVELS.INFO, " Q: " + stmt);
        await this._checkTableIsCreated(options);
        return new OrcoosFindCursor(this, stmt, bindings, options?.maxLimit);
    }
    
    /**
     * Returns the where clause of the NoSQL query based on the @param filter .
     * @param bindings is used to store the binding variables.
     */
    _computeWhere(filter, bindings) {
        if (!filter || this._isEmptyObject(filter)) {
            return '';
        }
        
        if (!(filter instanceof Object)) {
            this.log(LOG_LEVELS.SEVERE, 'o Error: Unexpected input value for where expression: ' + JSON.stringify(filter));
            throw Error('Unexpected input value for where expression: ' + JSON.stringify(filter));
        }
        
        if (filter._id && (typeof filter._id === "string" || 
            filter._id instanceof String || 
            filter._id instanceof ObjectId || 
            filter._id instanceof Object
        )) {
            let whereExp = this._computeWherePk(bindings, filter._id);
            return whereExp?.length > 0 ? ' WHERE (' + this._computeWherePk(bindings, filter._id) + ')' : '';
        } else {
            let cond = this._computeCompStartExp(filter, bindings);
            if (cond == "") {
                return "";
            }
            return ' WHERE ' + cond;
        }
    }

    /**
     * Returns the where expression for checking the @param _id equality.
     * @param bindings is used to store the binding variables.
     */
    _computeWherePk(bindings, _id) {
        if (!this._hasCompositeKeys) {
            return T + '.' + KVID + ' = ' + this._storeBinding(bindings, 'id', '' + _id);
        }

        return this._primaryKeyList
            .filter(v => _id[v])
            .map(v => T + '.' + v + ' = ' + this._storeBinding(bindings, 'id_' + v, _id[v]))
            .join(' AND ');
    }
    
    /**
     * Returns a comparison expression for non-keys based on @param compObj.
     * @param bindings is used to store the binding variables.
     */
    _computeCompStartExp(compObj, bindings) {
        if (!compObj || !(compObj instanceof Object || compObj instanceof ObjectId)) {
            this.log(LOG_LEVELS.SEVERE, 'o Error: Unexpected input value for a comparison expression: ' + JSON.stringify(compObj));
            throw Error('Query filter must be a plain object or ObjectId: ' + JSON.stringify(compObj));
        }
        return this._computeCompExp(compObj, bindings);
    }

    /**
     * Returns a comparison expression for non-keys based on @param compObj .
     * @param bindings is used to store the binding variables.
     */
    _computeCompExp(compObj, bindings) {
        if (compObj instanceof ObjectId) {
            return "" + compObj;
        }

        let res = '';
        for (const prop in compObj) {
            let propValue = compObj[prop];
            if (res !== '') {
                res += ' AND ';
            }
        
            if (prop.startsWith("$")) {
                switch(prop) {
                case "$or":
                    if (!propValue instanceof Array) {
                        throw Error("$or must be an array");
                    }
                    res += '(';
                    for (let i = 0; i < propValue.length; i++) {
                        if (i > 0) {
                            res += ' OR ';
                        }
                        res += this._computeCompExp(propValue[i], bindings);
                    }
                    res += ')';
                    break;
                case "$and":
                    if (!propValue instanceof Array) {
                        throw Error("$and must be an array");
                    }
                    res += '(';
                    for (let i = 0; i < propValue.length; i++) {
                        if (i > 0) {
                            res += ' AND ';
                        }
                        res += this._computeCompExp(propValue[i], bindings);
                    }
                    res += ')';
                    break;
                case "$not":
                    res += 'NOT(';
                    if (propValue instanceof Array) {
                            for (let i = 0; i < propValue.length; i++) {
                                if (i > 0) {
                                    res += ' AND ';
                                }
                                res += this._computeCompExp(propValue[i], bindings);
                            }
                    } else {
                        res += this._computeCompExp(propValue, bindings);
                    }
                    res += ')';
                    break;
                case "$nor":
                    if (!propValue instanceof Array) {
                        throw Error("$nor must be an array");
                    }
                    res += 'NOT(';
                    for (let i = 0; i < propValue.length; i++) {
                        if (i > 0) {
                            res += ' OR ';
                        }
                        res += this._computeCompExp(propValue[i], bindings);
                    }
                    res += ')';
                    break;
                default: 
                    throw Error("Unknown top level operator: " + prop);
                }
            } else if (propValue instanceof Object && Object.keys(propValue).length > 0) {
                let lres = '';
                for (const firstProp in propValue) {
                    if (lres !== '' && firstProp !== "$options") {
                        lres += ' AND ';
                    }
                    switch (firstProp) {
                    case "$gt":
                        lres += '(' + this._computeDbProp(prop) + ' > ' + 
                            this._storeBinding(bindings, prop, propValue[firstProp]) + ')';
                        break;
                    case "$gte":
                        lres += '(' + this._computeDbProp(prop) + ' >= ' + 
                            this._storeBinding(bindings, prop, propValue[firstProp]) + ')';
                        break;
                    case "$lt":
                        lres += '(' + this._computeDbProp(prop) + ' < ' + 
                            this._storeBinding(bindings, prop, propValue[firstProp]) + ')';
                        break;
                    case "$lte":
                        lres += '(' + this._computeDbProp(prop) + ' <= ' + 
                            this._storeBinding(bindings, prop, propValue[firstProp]) + ')';
                        break;
                    case "$ne":
                        lres += '(' + this._computeDbProp(prop) + ' != ' + 
                            this._storeBinding(bindings, prop, propValue[firstProp]) + ')';
                        break;
                    case "$eq":
                        lres += '(' + this._computeDbProp(prop) + ' = ' + 
                            this._storeBinding(bindings, prop, propValue[firstProp]) + ')';
                        break;
                    case "$exists":
                        lres += '(' + (propValue[firstProp] == false ? 'NOT ' : '') + 'EXISTS ' + T + '."' + prop +'")';
                        break;
                    case "$options":
                            // do nothing, it's taken care in the $regex branch below
                            break;
                    case"$regex":
                        if (propValue[firstProp] instanceof Object &&
                            propValue[firstProp]['$regex'] && 
                            propValue[firstProp]['$options'] && propValue[firstProp]['$options'] == 'i') {
                            lres += '( regex_like(' + this._computeDbProp(prop) + ', ' + 
                                this._storeBinding(bindings, prop, propValue[firstProp]['$regex']) + ') )';
                        } else if (propValue.$regex instanceof String || 
                            typeof propValue.$regex === "string") {
                            let opt = '';
                            if (propValue.$options && propValue.$options.includes('i')) {
                                opt += 'i';
                            }
                            if (propValue.$options && propValue.$options.includes('s')) {
                                opt += 's';
                            }
                            lres += '( regex_like(' + this._computeDbProp(prop) + ', ' + 
                                this._storeBinding(bindings, prop, propValue.$regex) + ',"' + opt + '") )';
                        } else {
                            this.log(LOG_LEVELS.SEVERE, 'o Error: Unexpected regex value for a comparison expression: ' + JSON.stringify(propValue));
                            throw Error('Unexpected regex value for a comparison expression: ' + JSON.stringify(propValue));
                        }
                        break;
                    case "$in":
                    case "$nin":
                        if (propValue[firstProp] instanceof Array && propValue[firstProp].length > 0) {
                            let kvProp = this._computeDbProp(prop);
                            let inRes = ' IN (';
                            let containsNull = false;
                            let inValCount = 0;
                            for (let i = 0; i < propValue[firstProp].length; i++) {
                                if (propValue[firstProp][i] === null) {
                                    containsNull = true;
                                    continue;
                                }
                                if (i > (containsNull ? 1: 0)) {
                                    inRes += ',';
                                }
                                inRes += this._storeBinding(bindings, prop, propValue[firstProp][i]);
                                inValCount++;
                            }
                            inRes += ')';
                            if (firstProp == "$in") {
                                if (inValCount > 0) {
                                    lres += '(' + kvProp + inRes + ' OR EXISTS (' + kvProp + '[$element' + inRes + '])';
                                }
                                if (containsNull) {
                                    lres += ' OR NOT EXISTS ' + kvProp;
                                }
                            } else {
                                if (inValCount > 0) {
                                    lres += ' NOT (' + kvProp + inRes + ' OR EXISTS (' + kvProp + '[$element' + inRes + '])';
                                }
                                if (containsNull) {
                                    lres += ' OR EXISTS ' + kvProp;
                                }
                            }
                            lres += ')';
                        } else {
                            // skip if this case: $in: []
                        }
                        break;
                    case "$size":
                        lres += '( size([' + this._computeDbProp(prop) + ']) = ' + propValue['$size'] + ' )'; 
                        break;
                    default:
                        this.log(LOG_LEVELS.SEVERE, 'o Error: Unexpected property value for a comparison expression: ' + JSON.stringify(propValue));
                        throw Error('Unexpected property value for a comparison expression: ' + JSON.stringify(propValue));
                    }
                }
                res += lres;
            } else if (propValue instanceof String || typeof propValue === "string" || 
                    propValue instanceof Date || 
                    propValue instanceof Number || typeof propValue === 'number' ||
                    propValue instanceof ObjectId) {
                if (prop == '_id') {
                    if (this._hasCompositeKeys) {
                        res += '(' + this._primaryKeyList
                            .map(v => 't.' + v + ' = ' + this._storeBinding(bindings, prop + '_' + v, propValue))
                            .join(' AND ') + ')';
                    } else {
                        res += '(t.' + KVID + ' = ' + this._storeBinding(bindings, prop, propValue) + ')';
                    }
                } else {
                    res += '(' + this._computeDbProp(prop) + ' =any ' + 
                        this._storeBinding(bindings, prop, propValue)
                        + ')';
                }
            } else {
                throw Error("ISE prop: " + prop + " propVal: " + propValue);
            }
        }
        if (res == "") {
            return "";
        }
        return '(' + res + ')';
    }
    
    /**
     * Given the name of a field, returns the DB path.
     * Ex: _id -> $t.kvid, a.b.c -> $t.a.b.c[]
     */
    _computeDbProp(prop) {
        if (prop instanceof String || typeof prop === "string") {
            if (prop.startsWith('_id')) {
                if (!this._hasCompositeKeys) {
                    return T + '.' + KVID;
                } else {
                    return T + '.' + prop.substring('_id'.length);
                }
            }

            let trProp = prop
                .split('.')
                .reduce((acc, cur) => {
                    if (this._isPositiveInteger(cur)) {
                      return acc + '[' + cur + ']';
                    }
                    return acc + '."' + cur +'"';
                  }, "");
            return T + trProp + "[]";
        }
        throw Error("Property is not a string type: " + typeof prop);
    }

    /**
     * Transforms prop ex: 'a.b.c' to  {'a': {'b': {'c': value }}}
     */
    _computeUpdateSetPutProp(prop, value) {
        if (prop instanceof String || typeof prop === "string") {
            let res = prop
                .split('.')
                .reduceRight( (acc, cur) => '{"' + cur + '": ' + acc + '}', value);
            return res;
        }
        return;
    }

    /**
     * Transforms prop ex: 'a.b.c' to  {'a': {'b': {'newProp': value }}}
     */
    _computeUpdateRenamePutProp(prop, renamedProp, value) {
        if (prop instanceof String || typeof prop === "string") {
            let li = prop.lastIndexOf('.');
            let newProp = prop.substring(0, li);
            return this._computeDbProp(newProp) + " " + this._computeUpdateSetPutProp(renamedProp, value);
        }
        return;
    }
        
    /**
     * True if number is >= 0
     */
    _isPositiveInteger(str) {
        var n = Math.floor(Number(str));
        return n !== Infinity && String(n) === str && n >= 0;
    }

    /**
     * Returns the sort SQL clase given a sortSpec
     * Ex: {a: asc, b.c: descending } -> ORDER BY $t.a ASC, $t.b.c DESC
     */
    _computeSortClause(sortSpec) {
        if (sortSpec) {
            if (typeof sortSpec !== 'object') {
                throw new Error('sortSpec not an object: ' + sort);
            }

            let sort = Object.keys(sortSpec).map((v, i) => {
                switch (sortSpec[v]) {
                    case 1:
                    case 'asc':
                    case 'ascending':
                        return this._computeDbProp(v) + ' ASC';
                    case -1:
                    case 'desc':
                    case 'descending':
                        return this._computeDbProp(v) + ' DESC';
                    default:
                        throw new Error('Unknown sort field: ' + v);
                }
            }).join(', ');
            return ' ORDER BY ' + sort;
        } 
        return '';
    }

    /**
     * Translates a limitSpec into a limit SQL clause. Error if limitSpec not a number.
     * Ex: 5 -> LIMIT 5
     */
    _computeLimitClause(limitSpec) {
        if (limitSpec) {
            if (typeof limitSpec === 'number')
            {   
                return ' LIMIT ' + limitSpec;
            }
            throw new Error('limitSpec not a number: ' + limitSpec);
        }
        return '';
    }

    /**
     * Given a skipSpec returns an offset. Error is skipSpec not a number.
     * Ex: 3 -> OFFSET 3
     */
    _computeOffsetClause(skipSpec) {
        if (skipSpec) {
            if (typeof skipSpec === 'number')
            {   
                return ' OFFSET ' + skipSpec;
            }
            throw new Error('skipSpec not a number: ' + skipSpec);
        }
        return '';
    }


    /** Returns the corect SQL literal to be appended to the statement */
    _computeLiteral(value) {
        if (!value || value === null) {
            return 'NULL';
        } else {
            return JSON.stringify(value);
        }
    }

    /**
     * Stores the a binding name, value into the bindings map. It generates 
     * a new name by appending a number if that name is already used.
     */
    _storeBinding(bindings, name, value) {
        if (!bindings) {
            return this._computeLiteral(value);
        }

        name = name.replace('.', '_');
        name = "$"  + name;
        if (!bindings[name]) {
           bindings[name] = value;
           return name;
        }

        for (let i = 2; i < MAX_BINDING_NAME; i++) {
            if (bindings[name + i]) {
                continue;
            }
            bindings[name + i] = value;
            return name + i;
        }
        throw Error("Too many bindings with base name: " + name);
    }

    /**
     * Given the bindings map it generates the binding variables declaration clause.
     */
    _computeBindingsClause(bindings) {
        if (bindings && Object.keys(bindings).length > 0) {
            let decl = '';
            for (let binding in bindings) {
                decl += binding + ' ' + this._computeBindingType(bindings[binding]) + ';';
            }
            if (decl.length > 0) {
                return 'DECLARE ' + decl + ' ';
            }
        }
        return '';
    }

    /**
     * Given a binding value it generates the SQL type for that vrible. 
     */
    _computeBindingType(nodeValue) {
        switch(typeof nodeValue) {
            // case 'Array':
            //     return [true, this._computeDbType(schemaPropType.caster)[1]];

            case 'string': 
            case 'Date':
            case 'ObjectId':
                return 'STRING';
            case 'number':
                return 'NUMBER';
            case 'boolean':
                return 'BOOLEAN';
            default:
                return 'ANYATOMIC';
        }
    }
    
    /**
     * Checks if obj is an empty object.
     */
    _isEmptyObject(obj) {
        return obj && typeof obj === 'object' && 
        Object.keys(obj).length === 0 &&
        !(obj instanceof Date) && !(obj instanceof ObjectId);
    }
    
    /**
     * Given a projection spec and using the Mongoose schema 
     * it generates the projection clause of the NoSQL query.
     */
    _conputeProjection(projection, schema) {
        if (!projection) {
            return '*';
        }

        if (! typeof projection === 'object') {
            throw Error("Projection is not an object: " + typeof projection);
        }

        let prjType = 0; // 0: unknown or empty projection {}, 1: all inclusions, -1: all exclusions

        // transform projection paths into object tree
        // ex: {'a.b.c': 1} => {'a': {'b': {'c': 1}}}
        let prjObj = {}
        for (let prop in projection) {       
            if (prop == "_id")
                continue;     
            if (projection[prop] == 1 || projection[prop] == true) {
                if (prjType == -1)
                    throw Error("Projection cannot be both inclusive and exclusive: " + JSON.stringify(projection));
                prjType = 1;
                // all inclusions
                this._computePrjObjDeep(prjObj, prop, projection[prop]);
            } else if (projection[prop] == 0 || projection[prop] == false) {
                if (prjType == 1)
                    throw Error("Projection cannot be both exclusive and inclusive: " + JSON.stringify(projection));
                prjType = -1;
                // all exclusions
                this._computePrjObjDeep(prjObj, prop, projection[prop]);                
            } else {
                // all other inclusions
                prjType = 1;
                this._computePrjObjDeep(prjObj, prop, projection[prop]);                
            }
        }
        
        if (prjType == -1 || prjType == 0) {
            // exclusions or '{}' all, ie it needs to include all but the exclusions
            // for this we need schema
            if ( !schema || typeof schema != 'object' || typeof schema.tree != 'object') {
                throw Error("Schema is not provided for the projection. Got projection: " + JSON.stringify(projection) + " schema: " + JSON.stringify(schema));
            }            
        
            for (let prop in schema.paths) {
                if (prop == '_id' || prop == 'id' || prop == '__v' ||
                    projection[prop] == 0 || projection[prop] == false) {
                    continue;
                }

                if (schema.paths[prop].instance == 'Date' || schema.paths[prop].instance == 'ObjectId' || 
                    schema.paths[prop].instance == 'Number' || schema.paths[prop].instance == 'String' ||
                    schema.paths[prop].instance == 'Boolean') {
                    if (prjObj[prop] == undefined) {
                        prjObj[prop] = 1;
                    }
                } else if (schema.paths[prop].instance == 'Array' && 
                    schema.paths[prop].schema && schema.paths[prop].schema.paths /*&& schema.paths[prop].schema.$isMongooseArray*/) {
                    if (prjObj[prop] == undefined) {
                        prjObj[prop] = {};
                    }
                    this._computePrjObjDeepExcl(prjObj[prop], prop, projection, schema.paths[prop].schema);
                } else if (schema.paths[prop].instance == 'Embedded' && 
                    schema.paths[prop].options && schema.paths[prop].options.type) {
                    if (prjObj[prop] == undefined) {
                        prjObj[prop] = {};
                    }
                    this._computePrjObjDeepExcl(prjObj[prop], prop, projection, schema.paths[prop].options.type);
                } else {
                    throw Error("Unsupported type: " + schema.paths[prop].type + ", prototype constructor: " + Object.getPrototypeOf(schema.paths[prop]).constructor.name);;
                }
            }
        }

        let res = "";
        // if it's an inclusion projection
        for (let prop in prjObj) {
            if (res != "") {
                res += ', ';
            }
            if (prjObj[prop] == 0 || prjObj[prop] == false) {            
                continue;
            } else if (prjObj[prop] == 1 || prjObj[prop] == true) {            
                res += this._computeDbProp(prop) + " AS " + prop + "";
            } else {
                res += this._computePrjDeep(prop, prjObj[prop], schema) + " AS " + prop + "";
            }
        }
        
        // add _id if not specified or if specified as inclusion
        if (projection['_id'] == undefined || projection._id == 1) {
            res = this._primaryKeyList.map(k => this._computeDbProp(k) + " AS " + k).join(', ') + ', ' + res;
        }

        return res;
    }

    /**
     * Recursively generate the projection object prjObj, based on the prop and value from the projSpec.
     */
    _computePrjObjDeep(prjObj, prop, value) {
        let dotIndex = prop.indexOf('.');
        if ( dotIndex > 0) {
            let propBase = prop.substring(0, dotIndex);
            let propChild = prop.substring(dotIndex + 1);
            if (prjObj[propBase] == undefined)
                prjObj[propBase] = {};
            this._computePrjObjDeep(prjObj[propBase], propChild, value);
        } else {
            if (prjObj[prop] == undefined)
                prjObj[prop] = value;
            else
                Error("Duplicate property in projection: " + prop);
        }
    }

    /**
     * Recursively generate the projection string for a field. 
     */
    _computePrjDeep(propBase, propChild, schema) {
        let res = "";

        if (propChild instanceof Object) {
            for (let prop in propChild) {
                if (res != "") {
                    res += ', ';
                }
                if (prop.startsWith('$')) {
                    return this._computePrjOperators(prop, propChild[prop]);
                } else if (propChild[prop] == 0 || propChild[prop] == false) {
                    continue;
                } else if (propChild[prop] == 1 || propChild[prop] == true) {
                    res += "'" + prop + "': " + this._computeDbProp(propBase + '.' + prop) + "";
                } else {
                    res += "'" + prop + "': " + this._computePrjDeep(propBase + '.' + prop, propChild[prop], schema);
                }
            }
            let isArray = this._isSchemaArray(schema, propBase);
            res = isArray ? '[{' + res + '}]' : '{' + res + '}';
            return res;
        } else if (typeof(propChild) == 'number') {
            return propChild;
        } else if (typeof(propChild) == 'string') {
            if (propChild.startsWith('$')) {
                return this._computeDbProp(propChild.substring(1));
            }
            return "'" + propChild + "'";
        } else {
            throw Error("Unsupported type: " + propChild);
        }
    }
    
    /**
     * Checks if the path in the schema is an array. 
     */
    _isSchemaArray(schema, path) {
        let schemaPropType = schema.path(path);
        if (!schemaPropType || !schemaPropType.instance) {
            return false;
        }
        return schemaPropType.instance === 'Array';
    }

    /**
     * Fills in the prjObj for exclusions.
     */
    _computePrjObjDeepExcl(prjObj, baseProp, projection, schema) {
        if ( !schema || !schema.paths || typeof schema.paths != 'object') {
            throw Error("Schema is not provided for the projection. Got: " + JSON.stringify(schema));
        }
    
        for (let prop in schema.paths) {
            if (prop == '_id' || prop == 'id' || prop == '__v' ||
                projection[baseProp + "." + prop] == 0 || projection[baseProp + '.' + prop] == false) {
                continue;
            }

            if (schema.paths[prop].instance == 'Date' || schema.paths[prop].instance == 'ObjectId' || 
                    schema.paths[prop].instance == 'Number' || schema.paths[prop].instance == 'String' ||
                    (schema.paths[prop].instance == 'Array' && !schema.paths[prop].schema)) {
                    if (prjObj[prop] == undefined) {
                        prjObj[prop] = 1;
                    }
                } else if (schema.paths[prop].instance == undefined && 
                    schema.paths[prop].schema && schema.paths[prop].schema.paths /*&& schema.paths[prop].schema.$isMongooseArray*/) {
                        if (prjObj[prop] == undefined) {
                            prjObj[prop] = {};
                        }
                        this._computePrjObjDeepExcl(prjObj[prop], baseProp + "." + prop, projection, schema.paths[prop].schema);
                } else if (schema.paths[prop].instance == undefined && 
                    schema.paths[prop].options && schema.paths[prop].options.type) {
                        if (prjObj[prop] == undefined) {
                            prjObj[prop] = {};
                        }
                        this._computePrjObjDeepExcl(prjObj[prop], baseProp + "." + prop, projection, schema.paths[prop].options.type);
                } else {
                    throw Error("Unsupported type: " + schema.paths[prop].type + ", prototype constructor: " + Object.getPrototypeOf(schema.paths[prop]).constructor.name);;
            }
        }
    }

    /**
     * Translates a projection property into the NoSQL expression.
     */
    _computePrjOperators(prop, params) {
        if (typeof(prop)!='string' || !prop.startsWith('$')) {
            throw Error("Invalid operator property: " + prop);
        }

        // Arithmetics
        if (prop == '$multiply') {
            if (!params instanceof Array) {
                throw Error("Invalid $multiply params: " + params);
            }
            return '(' + params.map(v => this._computePrjOperands(v)).join(' * ') + ')';
        } else if (prop == '$divide') {
            if (!params instanceof Array) {
                throw Error("Invalid $divide params: " + params);
            }
            return '(' + params.map(v => this._computePrjOperands(v)).join(' div ') + ')';
        } else if (prop == '$mod') {
            if (!params instanceof Array || params.length!= 2) {
                throw Error("Invalid $mod value: " + params);
            }
            let m = this._computePrjOperands(params[0]);
            let n = this._computePrjOperands(params[1])
            return '(' + m + '-(' + m + '/' + n + '*' + n + '))';
        } else if (prop == '$add') {
            if (!params instanceof Array) {
                throw Error("Invalid $add params: " + params);
            }
            return '(' + params.map(v => this._computePrjOperands(v)).join(' + ') + ')';
        } else if (prop == '$subtract') {
            if (!params instanceof Array) {
                throw Error("Invalid $subtract params: " + params);
            }
            return '(' + params.map(v => this._computePrjOperands(v)).join(' - ') + ')';
        } else if (prop == '$abs') {
            if (!params instanceof Number || !params instanceof String || !params instanceof Object) {
                throw Error("Invalid $abs params: " + params);
            }
            return 'abs(' + this._computePrjOperands(params) + ')';
        } else if (prop == '$ceil') {
            if (!params instanceof Number || !params instanceof String || !params instanceof Object) {
                throw Error("Invalid $ceil params: " + params);
            }
            return 'ceil(' + this._computePrjOperands(params) + ')';
        } else if (prop == '$floor') {
            if (!params instanceof Number || !params instanceof String || !params instanceof Object) {
                throw Error("Invalid $floor params: " + params);
            }
            return 'floor(' + this._computePrjOperands(params) + ')';
        } else if (prop == '$round') {
            if (!params instanceof Array || params.length < 1 || params.length > 2) {
                throw Error("Invalid $round params: " + params);
            }
            return 'round(' + params.map(v => this._computePrjOperands(v)).join(', ') + ')';
        } else if (prop == '$trunc') {
            if (!params instanceof Array || params.length < 1 || params.length > 2) {
                throw Error("Invalid $trunc params: " + params);
            }
            return 'trunc(' + params.map(v => this._computePrjOperands(v)).join(', ') + ')';
        } else if (prop == '$exp') {
            if (!params instanceof Number || !params instanceof String || !params instanceof Object) {
                throw Error("Invalid $exp params: " + params);
            }
            return 'exp(' + this._computePrjOperands(params) + ')';
        } else if (prop == '$log') {
            if (!params instanceof Array || params.length < 1 || params.length > 2) {
                throw Error("Invalid $log params: " + params);
            }
            return 'log(' + params.map(v => this._computePrjOperands(v)).join(', ') + ')';
        } else if (prop == '$ln') {
            if (!params instanceof Number || !params instanceof Object) {
                throw Error("Invalid $ln params: " + params);
            }
            return 'ln(' + this._computePrjOperands(params) + ')';
        } else if (prop == '$log10') {
            if (!params instanceof Number || !params instanceof String || !params instanceof Object) {
                throw Error("Invalid $log10 params: " + params);
            }
            return 'log10(' + this._computePrjOperands(params) + ')';
        } else if (prop == '$pow') {
            if (!params instanceof Array || params.length < 1 || params.length > 2) {
                throw Error("Invalid $pow params: " + params);
            }
            return 'power(' + params.map(v => this._computePrjOperands(v)).join(', ') + ')';
        } else if (prop == '$sqrt') {
            if (!params instanceof Number || !params instanceof String || !params instanceof Object) {
                throw Error("Invalid $sqrt params: " + params);
            }
            return 'sqrt(' + this._computePrjOperands(params) + ')';
        
        // Trigonometry
        } else if (prop == '$cos') {
            if (!params instanceof Number || !params instanceof String || !params instanceof Object) {
                throw Error("Invalid $cos params: " + params);
            }
            return 'cos(' + this._computePrjOperands(params) + ')';
        } else if (prop == '$sin') {
            if (!params instanceof Number || !params instanceof String || !params instanceof Object) {
                throw Error("Invalid $sin params: " + params);
            }
            return 'sin(' + this._computePrjOperands(params) + ')';
        } else if (prop == '$tan') {
            if (!params instanceof Number || !params instanceof String || !params instanceof Object) {
                throw Error("Invalid $atan params: " + params);
            }
            return 'tan(' + this._computePrjOperands(params) + ')';            
        } else if (prop == '$acos') {
            if (!params instanceof Number || !params instanceof String || !params instanceof Object) {
                throw Error("Invalid $acos params: " + params);
            }
            return 'acos(' + this._computePrjOperands(params) + ')';
        } else if (prop == '$asin') {
            if (!params instanceof Number || !params instanceof String || !params instanceof Object) {
                throw Error("Invalid $asin params: " + params);
            }
            return 'asin(' + this._computePrjOperands(params) + ')';
        } else if (prop == '$atan') {
            if (!params instanceof Number || !params instanceof String || !params instanceof Object) {
                throw Error("Invalid $atan params: " + params);
            }
            return 'atan(' + this._computePrjOperands(params) + ')';
        } else if (prop == '$atan2') {
            if (!params instanceof Array || params.length != 2) {
                throw Error("Invalid $atan2 params: " + params);
            }
            return 'atan2(' + this._computePrjOperands(params[0]) + ', ' + this._computePrjOperands(params[1]) + ')';
        } else if (prop == '$radiansToDegrees') {
            if (!params instanceof Number || !params instanceof String || !params instanceof Object) {
                throw Error("Invalid $radiansToDegrees params: " + params);
            }
            return 'degrees(' + this._computePrjOperands(params) + ')';
        } else if (prop == '$degreesToRadians') {
            if (!params instanceof Number || !params instanceof String || !params instanceof Object) {
                throw Error("Invalid $degreesToRadians params: " + params);
            }
            return 'radians(' + this._computePrjOperands(params) + ')';
        } else if (prop == '$rand') {
            if (!params instanceof Object) {
                throw Error("Invalid $concat value: " + params);
            }
            return 'rand()';
        
        // Comparison
        } else if (prop == '$eq') {
            if (!params instanceof Array) {
                throw Error("Invalid $eq params: " + params);
            }
            return '(' + params.map(v => this._computePrjOperands(v)).join(' = ') + ')';
        } else if (prop == '$ne') {
            if (!params instanceof Array) {
                throw Error("Invalid $ne params: " + params);
            }
            return '(' + params.map(v => this._computePrjOperands(v)).join(' != ') + ')';
        } else if (prop == '$gt') {
            if (!params instanceof Array) {
                throw Error("Invalid $gt params: " + params);
            }
            return '(' + params.map(v => this._computePrjOperands(v)).join(' > ') + ')';
        } else if (prop == '$gte') {
            if (!params instanceof Array) {
                throw Error("Invalid $gte params: " + params);
            }
            return '(' + params.map(v => this._computePrjOperands(v)).join(' >= ') + ')';
        } else if (prop == '$lt') {
            if (!params instanceof Array) {
                throw Error("Invalid $lt params: " + params);
            }
            return '(' + params.map(v => this._computePrjOperands(v)).join(' < ') + ')';
        } else if (prop == '$lte') {
            if (!params instanceof Array) {
                throw Error("Invalid $lte params: " + params);
            }
            return '(' + params.map(v => this._computePrjOperands(v)).join(' <= ') + ')';

        // Logical
        } else if (prop == '$and') {
            if (!params instanceof Array) {
                throw Error("Invalid $and params: " + params);
            }
            return '(' + params.map(v => this._computePrjOperands(v)).join(' AND ') + ')';
        } else if (prop == '$or') {
            if (!params instanceof Array) {
                throw Error("Invalid $or params: " + params);
            }
            return '(' + params.map(v => this._computePrjOperands(v)).join(' OR ') + ')';
        } else if (prop == '$not') {
            if (typeof(params) != 'string') {
                throw Error("Invalid $not params: " + params);
            }
            return '( NOT ' + this._computePrjOperands(params) + ')';

        // String functions
        } else if (prop == '$concat') {
            if (!params instanceof Array) {
                throw Error("Invalid $concat params: " + params);
            }
            return 'concat(' + params.map(v => this._computePrjOperands(v)).join(', ') + ')';
        } else if (prop == '$substrCP') {
            if (!params instanceof Array) {
                throw Error("Invalid $substrCP params: " + params);
            }
            return 'substring(' + params.map(v => this._computePrjOperands(v)).join(', ') + ')';
        } else if (prop == '$toUpper') {
            if (!params instanceof String || !params instanceof Object) {
                throw Error("Invalid $toUpper params: " + JSON.stringify(params));
            }
            return 'upper(' + this._computePrjOperands(params) + ')';
        } else if (prop == '$toLower') {
            if (!params instanceof String || !params instanceof Object) {
                throw Error("Invalid $toLower params: " + JSON.stringify(params));
            }
            return 'lower(' + this._computePrjOperands(params) + ')';
        } else if (prop == '$trim') {
            if (!params instanceof Object || !params['input']) {
                throw Error("Invalid $trim params: " + JSON.stringify(params));
            }
            return 'trim(' + this._computePrjOperands(params['input']) + ', "both"' + 
                (params['chars'] ? ', ' + this._computePrjOperands(params['chars']) : '') + ')';
        } else if (prop == '$ltrim') {
            if (!params instanceof Object || !params['input']) {
                throw Error("Invalid $ltrim params: " + JSON.stringify(params));
            }
            return 'trim(' + this._computePrjOperands(params['input']) + ', "leading"' + 
                (params['chars'] ? ', ' + this._computePrjOperands(params['chars']) : '') + ')';
        } else if (prop == '$rtrim') {
            if (!params instanceof Object || !params['input']) {
                throw Error("Invalid $rtrim params: " + JSON.stringify(params));
            }
            return 'trim(' + this._computePrjOperands(params['input']) + ', "trailing"' + 
                (params['chars'] ? ', ' + this._computePrjOperands(params['chars']) : '') + ')';
        } else if (prop == '$strLenCP') {
            if (!params instanceof String || !params instanceof Object) {
                throw Error("Invalid $strLenCP params: " + JSON.stringify(params));
            }
            return 'length(' + this._computePrjOperands(params) + ')';
        } else if (prop == '$indexOfCP') {
            if (!params instanceof Array || params.length < 2 || params.length > 3) {
                throw Error("Invalid $indexOfCP params: " + JSON.stringify(params));
            }
            return 'index_of(' + this._computePrjOperands(params[0]) + ', ' + 
                this._computePrjOperands(params[1]) + 
                (params.length == 3 ? ',' + this._computePrjOperands(params[2]) : '') + 
                ')';
        
        // Other
        // todo: look into array operations $filter, $first, $last, $slice, $elemMatch, $size, $indexOfArray, $reduce
        // todo: Date/Time functs

        } else {
            throw Error("Unsupported operator: " + prop);
        }
    }

    /**
     * Translates projection operands.
     */
    _computePrjOperands(value) {
        if (typeof(value) == 'string') {
            if (value.startsWith('$')) {
                return this._computeDbProp(value.substring(1));
            }
            return "'" + value + "'";
        } else if (typeof(value) == 'number') {
            return value;
        } else if (typeof(value) == 'boolean') {
            return value;
        } else if (typeof(value) == 'object' && 
            Object.keys(value).length == 1 && Object.keys(value)[0].startsWith('$')) {
            let prop = Object.keys(value)[0];
            return this._computePrjOperators(prop, value[prop]);
        }

        throw Error("Invalid operand value: " + value);
    }

    /**
     * Inserts all the docs into the store. 
     * This implementation is not atomic since keys can be on any shard.
     * It ignores write concern and options altogether.
     */
    async insertMany(docs, options) {
        let promises = [];
        for (let doc of docs) {
            promises.push(this.insertOne(doc, options));
        }
        
        let res = {
            acknoledged: true,
            insertedCount: 0,
            insertedIds: []
        };
        try {
            let rs = await Promise.all(promises);
            for (let r of rs) {
                if (r.acknoledged) {
                    res.insertedCount++;
                    res.insertedIds.push(r.insertedId);
                }   
            }
            return res;
        } catch (err) {
            throw err; 
        }
    }

    /**
     * Creates an indexes in the store based on keys array.
     */
    async createIndex(keys, options, schema) {
        this.log(LOG_LEVELS.FINNER, "o createIndex model: " + JSON.stringify(schema?.obj));
        let idxName = '';
        let params = "";
        for (const [key, value] of Object.entries(keys)) {
            if (key.includes('*') || key.includes('$')) {
                throw Error("Orcoos does not support wildcard indexes, received: " + key);
            }
            if (value != 1) {
                throw Error("Orcoos supports indexes only on path values equal to 1, received: " + value);
            }
            idxName += '_' + key.replaceAll('.', '');

            let indexProperty = this._computeIndexProperty(key, schema);
            if (params.length > 0) {
                params += ", ";
            }
            params += indexProperty;
        }

        this._checkTableIsCreated(options);

        idxName = options?.name ? options.name : "idx_" + this.colName + idxName;
        let ddl = "CREATE INDEX IF NOT EXISTS " + idxName + " ON " + this.colName + 
            " (" + params + ")"
        this.log(LOG_LEVELS.INFO, " DLL: " + ddl);

        let result = await this.db.client.tableDDL(ddl, this._options);
        await this.db.client.forCompletion(result);

        return idxName;
    }

    /**
     * Translates an index field in a SQL path.
     */
    _computeIndexProperty(prop, schema) {
        if ( !((prop instanceof String || typeof prop === "string" ) && 
                prop.length > 0)) {
            throw Error("Property is not a non-empty string: " + typeof prop);
        }
        
        if (!schema || typeof schema != 'object' || typeof schema.path != 'function') {
            throw Error("Schema is not provided for the index. Got: " + JSON.stringify(schema));
        }

        let steps = prop.split('.');
        let dbProp = "";
        let lastStepType = "";
        for (let index = 0; index < steps.length; index++) {
            let path = steps.slice(0, index + 1).join('.');
            let schemaPropType = schema.path(path);
            if (!schemaPropType || !schemaPropType.instance) {
                throw Error("No property named: " + step + " found for " + this.colName);
            }
            let [isArray, dbPropType] = this._computeDbType(schemaPropType);
            if (dbProp.length > 0) {
                dbProp += ".";
            }
            dbProp += steps[index] + (isArray? "[]" : "");
            lastStepType = dbPropType;
        }

        return dbProp + " AS " + lastStepType;
    }
    
    /**
     * Computes the type of the index path.
     */
    _computeDbType(schemaPropType) {
        switch(schemaPropType.instance) {
            case 'Array':
                return [true, this._computeDbType(schemaPropType.caster)[1]];

            // All other cases are treated as ANYATOMIC for compatibility if user decides t change the type later
            case 'String': 
                // return [false, "STRING"];
            case 'Number':
                // return [false, "NUMBER"];
            case 'Boolean':
                // return [false, "BOOLEAN"];
            case 'Date':
                // return [false, 'STRING'];
            default:
                return [false, "ANYATOMIC"];
        }
    }

    /**
     * Returns a list of all the indexes.
     */
    listIndexes() {
        this.log(LOG_LEVELS.FINNER, "    o listIndexes " + this.colName);
        let tableName = this.colName;

        return new OrcoosArray(async() => {
            let result = await this.db.client.getIndexes(tableName, this._options);
            let res = result.map(v => {
                let idxKey = {};
                v.fields?.map(v => 
                    {
                        idxKey[v.substring(7).replaceAll('"', '')] = 1;
                    });

                return { name: v.indexName, key: idxKey};
            });
            return res;
        });
    }

    /**
     * Drops the idxName index. 
     */
    async dropIndex(idxName, options) {
        this.log(LOG_LEVELS.FINNER, "    o dropIndex " + this.colName + " idx: " + idxName);
        this._checkTableIsCreated(options);
        let ddl = "DROP INDEX IF EXISTS " + idxName + " ON " + this.colName;
        this.log(LOG_LEVELS.INFO, " DLL: " + ddl);

        let result = await this.db.client.tableDDL(ddl, this._options);
        await this.db.client.forCompletion(result);
        return result;
    }

    /**
     * Logs the @param msg to console depending on the @param level .
     */
    log(level, msg) {
        if (this.db.options && this.db.options['logLevel'] >= level) {
            console.log(msg);
        }
        if (level <= LOG_LEVELS.WARNING) {
            utils.warn(msg);
        }
    }
}

/**
 * Represents a cursor over the results of a query. The query is not executed 
 * until the results are requested. 
 */
class OrcoosFindCursor {
    _documents = [];
    _isStarted = false;
    _isClosed = false;

    constructor(collection, statement, bindings, maxLimit = MAX_QUERY_RESULTS_LIMIT) {
        this.collection = collection;
        this.statement = statement;
        this.bindings = bindings;
        this.maxLimit = maxLimit;
    }

    /**
     * Gets the next batch of results from the store.
     */
    async fetchBatch() {
        if (this._isClosed) {
          return;
        }

        if (!this._isStarted) {
            // first time fetch is called
            this._isStarted = true;
            let prepStmt = this.collection.db.prepStmtCache.get(this.statement);
            if (!prepStmt) {
                prepStmt = await this.collection.db.client.prepare(this.statement, {...this.collection._options});
                this.collection.db.prepStmtCache.set(this.statement, prepStmt);
            }

            if (this.bindings && Object.keys(this.bindings).length > 0) {
                prepStmt = await prepStmt.copyStatement();
                for (let binding in this.bindings) {
                    prepStmt.set(binding, this.bindings[binding]);
                }
            }

            try {
                this._gen = await this.collection.db.client.queryIterable(prepStmt, this.collection._options);
            } catch(e) {
                console.log('!!! queryIterableException: ' + e + ' \n clear cache !!!');
                // if query errors remove prepared queries from cache to allow the user to rerun it when table has changed.
                this.collection.db.prepStmtCache.clear();
                throw e;
            }
        }

        if (!this._gen) {
            this.close();
            return;
        }
        
        let batch = await this._gen.next();

        if (batch && batch?.value?.rows) {
            this._documents = batch.value.rows.map(r => OrcoosCollection._unmarshalObjectFromRow(OrcoosCollection._fixTypesAfterRead(r)));
            return;
        } else {
            this.close();
        }
    }
    
    /**
     * Returns an array of documents. The caller is responsible for making sure that there
     * is enough memory to store the results. 
     * Note: The maximum number of documents that will be returned is determined by the
     * `maxLimit` parameter passed to the query method.
     */
    async toArray() {
        const array = [];

        while(true) {
            if (this._documents?.length >= 0) {
                if (array.length + this._documents?.length > this.maxLimit) {
                    throw new Error("Query results count: " + (array.length + this._documents?.length) + ' more than toArray maxLimit: ' + this.maxLimit);
                }
                array.push(...this._documents);
                await this.fetchBatch();
                if (this._isClosed) {
                    break;
                }
            } else {
                break;
            }
        }

        return array;
    }

    async* map(mapper, thisArg = null) {
        for await (const val of this) {
            yield mapper.call(thisArg, val);
        }
    }

    /**
     * Returns an async iterator over the query results. 
     * Calls fetchBatch when there are no more results available to the iterator.
     */
    async *[Symbol.asyncIterator]() {
        if (this._isClosed) {
            return;
        }

        if (!this._isStarted) {
            this.fetchBatch();
            this._isStarted = true;
        }
        
        try {
            while (true) {            
                if (this._isClosed) {
                    return;
                }
                
                const document = await this.next();
                
                if (document === null) {
                    return;
                }
                
                yield document;
            }
        } finally {
            // Only close the cursor if it has not already been closed. This finally clause handles
            // the case when a user would break out of a for await of loop early.
            if (!this._isClosed) {
                this.close();
            }
        }
    }
    
    // Doesn't seem to be required.
    stream(options) {        
        //return new ReadableCursorStream(this);
        throw new Error('OrcoosFindCursor.stream() not implemented.');
    }
    
    /**
     * Checks if there are any more results available.
     */
    async hasNext() {           
        do {
            if ((this._documents?.length ?? 0) !== 0) {
                return true;
            }
            await this.fetchBatch();
        } while ((this._documents?.length ?? 0) !== 0);
    
        return false;
    }
    
    /** 
     * Gets the next available document from the cursor, returns null if 
     * no more documents are available. 
     */
    async next() {
        do {
            const doc = this._documents?.shift();
            if (doc != null) {
                return doc;
            }
            await this.fetchBatch();
        } while ((this._documents?.length ?? 0) !== 0);
    
        return null;
    }
    
    /**
     * Try to get the next available document from the cursor or `null` if an empty batch is returned
     */
    async tryNext() {            
        let doc = this._documents?.shift();
        if (doc != null) {
            return doc;
        }

        await this.fetchBatch();

        doc = this._documents?.shift();
        if (doc != null) {
            return doc;
        }

        return null;
    }
    
    /**
     * Iterates over all the documents for this cursor using the iterator, callback pattern.
     *
     * If the iterator returns `false`, iteration will stop.
     *
     * @param iterator - The iteration callback.
     * @deprecated - Will be removed in a future release. Use for await...of instead.
     */
    async forEach(iterator) {
        if (typeof iterator !== 'function') {
          throw new Error('Argument "iterator" must be a function');
        }
        for await (const document of this) {
            const result = iterator(document);
            if (result === false) {
                break;
            }
        }
    }

    /**
     * Closes the cursor.
     */
    async close() {
        this._isClosed = true;
    }

    /**
     * An alias for {@link close()}.
     */
    async [Symbol.asyncDispose]() {
        return this.close();
    }
}

class OrcoosUpdateQuery {
    constructor(collection, statement, options) {
        this._collection = collection;
        this._query     = statement;
        this._options = options;
    }

    async exec(operation = null) {
        await this._collection._checkTableIsCreated(this._options);

        const r = await this._collection._queryPromise(this._collection.db.client, this._stmt, undefined, this._options);
        let res = {value: (r && r[0] ? r[0] : null),
                   ok: (r && r[0] ? 1 : 0)};

        return res;
    }
}

/**
 * Lazy array that executes only when toArray is called.
 */
class OrcoosArray {
    constructor(f) {
        this.f = f;
    }
    
    async toArray() {
        return this.f();
    }
}
  
module.exports.OrcoosClient = OrcoosClient;
module.exports.OrcoosCollection = OrcoosCollection;
module.exports.MAX_QUERY_RESULTS_LIMIT = MAX_QUERY_RESULTS_LIMIT;