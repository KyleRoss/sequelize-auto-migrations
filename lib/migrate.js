"use strict";

const Sequelize         = require("sequelize");
const hash              = require("object-hash");
const _                 = require("lodash");
const diff              = require('deep-diff').diff;
const beautify          = require('js-beautify').js_beautify;

const fs                = require("fs");
const path              = require("path");

let log                 = console.log;

const reverseSequelizeColType = function(col, prefix = 'Sequelize.') 
{
    const attrName = col['type'].key
    const attrObj = col.type
    const options = (col['type']['options']) ? col['type']['options'] : {}
    const DataTypes = Sequelize.DataTypes

    switch (attrName) {
        // CHAR(length, binary)
        case DataTypes.CHAR.key:
            if (options.binary)
                return prefix + 'CHAR.BINARY';
            return prefix + 'CHAR('+options.length+')';

        // STRING(length, binary).BINARY
        case DataTypes.STRING.key:
            return prefix + 'STRING' + ( (options.length) ? '('+options.length+')' : '' ) +
            ((options.binary) ? '.BINARY' : '');

        // TEXT(length)
        case DataTypes.TEXT.key:
            if (!options.length)
                return prefix + 'TEXT';
            return prefix + 'TEXT('+options.length.toLowerCase()+')';

        // NUMBER(length, decimals).UNSIGNED.ZEROFILL
        case DataTypes.NUMBER.key:
        case DataTypes.TINYINT.key:
        case DataTypes.SMALLINT.key:
        case DataTypes.MEDIUMINT.key:
        case DataTypes.BIGINT.key:
        case DataTypes.FLOAT.key:
        case DataTypes.REAL.key:
        case DataTypes.DOUBLE.key:
        case DataTypes.DECIMAL.key:
        case DataTypes.JSON.key:
        case DataTypes.INTEGER.key: {
            let ret = attrName;
            if (options.length)
            {
                ret += '('+options.length;
                if (options.decimals)
                    ret += ', ' + options.decimals;
                ret += ')';
            }

            if (options.precision) {
                ret += '('+options.precision;
                if (options.scale)
                    ret += ', ' + options.scale;
                ret += ')';
            }
            
            ret = [ ret ];

            if (options.zerofill)
                ret.push('ZEROFILL');
                
            if (options.unsigned)
                ret.push('UNSIGNED');
            
            return prefix + ret.join('.');        
        }

        case DataTypes.ENUM.key: 
            return prefix + "ENUM('" +options.values.join("', '")+"')";

        case DataTypes.BLOB.key:
            if (!options.length)
                return prefix + 'BLOB';
            return prefix + 'BLOB('+options.length.toLowerCase()+')';

        case DataTypes.ENUM.key:
            return prefix + "ENUM('" +options.values.join("', '")+"')";

        case DataTypes.GEOMETRY.key:
            if (options.type) {
                if (options.srid)
                    return prefix + "GEOMETRY('" + options.type +"', "+options.srid+")";
                else
                    return prefix + "GEOMETRY('" + options.type +"')";
            }
            return prefix + 'GEOMETRY';

        case DataTypes.GEOGRAPHY.key:
            return prefix + 'GEOGRAPHY';

        case DataTypes.ARRAY.key:
          const _type = attrObj.toString();
          let arrayType;
          if(_type === 'INTEGER[]' || _type === 'STRING[]') {
            arrayType = prefix + _type.replace('[]', '');
          } else {
            arrayType = (col.seqType === 'Sequelize.ARRAY(Sequelize.INTEGER)') ? prefix + 'INTEGER' : prefix + 'STRING';
          }
          return prefix + `ARRAY(${arrayType})`;
            
        case DataTypes.RANGE.key:
            console.warn(attrName + ' type not supported, you should make it by')
            return prefix + attrObj.toSql()

        // BOOLEAN
        // TIME
        // DATE
        // DATEONLY
        // HSTORE
        // JSONB
        // UUID
        // UUIDV1
        // UUIDV4
        // VIRTUAL
        // INET
        // MACADDR
        default:
            return prefix + attrName
    }
};

const reverseSequelizeDefValueType = function(defaultValue, prefix = 'Sequelize.') 
{ 
    if (typeof defaultValue === 'object') {
        if (defaultValue.constructor && defaultValue.constructor.name) {
            return { internal: true, value: prefix + defaultValue.constructor.name };
        } 
    }   

    if (typeof defaultValue === 'function')
        return { notSupported: true, value: '' };

    return { value: defaultValue };
};

const parseIndex = function(idx) 
{
    delete idx.parser;
    if (idx.type == "")
        delete idx.type;
    
    let options = { };
    
    if (idx.name)
        options.name = options.indexName = idx.name; // The name of the index. Default is __

    // @todo: UNIQUE|FULLTEXT|SPATIAL
    if (idx.unique)
        options.type = options.indicesType = 'UNIQUE';

    if (idx.method)
        options.indexType = idx.type; // Set a type for the index, e.g. BTREE. See the documentation of the used dialect

    if (idx.parser && idx.parser != "")
        options.parser = idx.parser; // For FULLTEXT columns set your parser
    
    idx.options = options;

    idx.hash = hash(idx);

//    log ('PI:', JSON.stringify(idx, null, 4));
    return idx;
};

const reverseModels = function(sequelize, models)
{
    let tables = {};
    
    delete models.default;
    
    for (let model in models)
    {
        let attributes = models[model].attributes || models[model].rawAttributes;
    
        for (let column in attributes)
        {
            delete attributes[column].Model;
            delete attributes[column].fieldName;
            // delete attributes[column].field;
            
            for(let property in attributes[column]) 
            {
                if(property.startsWith('_'))
                {
                    delete attributes[column][property];
                    continue;
                }
                
                if (property === 'defaultValue')
                {
                    let _val = reverseSequelizeDefValueType(attributes[column][property]);
                    if (_val.notSupported)
                    {
                        log(`[Not supported] Skip defaultValue column of attribute ${model}:${column}`);
                        delete attributes[column][property];
                        continue;
                    }
                    attributes[column][property] = _val;
                }
                
                if (property === 'validate') {
                    delete attributes[column][property];
                }
                
                // remove getters, setters...
                if (typeof attributes[column][property] == 'function')
                    delete attributes[column][property];
            }
            
            if(typeof attributes[column]['type'] === 'undefined') 
            {
              if(!attributes[column]['seqType']) 
              {
                log(`[Not supported] Skip column with undefined type ${model}:${column}`);
                delete attributes[column];
                continue;
              } else {
                if(!['Sequelize.ARRAY(Sequelize.INTEGER)', 'Sequelize.ARRAY(Sequelize.STRING)'].includes(attributes[column]['seqType'])) {
                  delete attributes[column];
                  continue;
                }
                attributes[column]['type'] = {
                  key: Sequelize.ARRAY.key
                }
              }
            }
            
            let seqType = reverseSequelizeColType(attributes[column]);
            
            // NO virtual types in migration
            if (seqType === 'Sequelize.VIRTUAL')
            {
                log(`[SKIP] Skip Sequelize.VIRTUAL column "${column}"", defined in model "${model}"`);
                delete attributes[column];
                continue;
            }
            
            if (!seqType)
            {
                if(typeof attributes[column]['type']['options'] !== 'undefined' && typeof attributes[column]['type']['options'].toString === 'function')
                    seqType = attributes[column]['type']['options'].toString(sequelize);
                    
                if(typeof attributes[column]['type'].toString === 'function') 
                    seqType = attributes[column]['type'].toString(sequelize);            
            }
            
            attributes[column]['seqType'] = seqType;
            
            delete attributes[column].type;
            delete attributes[column].values; // ENUM
        }
    
        tables[models[model].tableName] = {
            tableName: models[model].tableName,
            schema: attributes
        };
    
        if (models[model].options.indexes.length > 0)
        {
            let idx_out = {};
            for (let _i in models[model].options.indexes)
            {
                let index = parseIndex(models[model].options.indexes[_i]);
                idx_out[index.hash+''] = index;
                delete index.hash;
                
                // make it immutable
                Object.freeze(index);
            }
            models[model].options.indexes = idx_out;
        }
        
        if (typeof models[model].options.charset !== 'undefined')
        {
            tables[models[model].tableName].charset = models[model].options.charset;
        }
        
        tables[models[model].tableName].indexes = models[model].options.indexes;
        
        if(models[model].options.enableAudit) {
            tables[models[model].tableName].audit = true;
        }
    }
    
    return tables;
};

const parseDifference = function(previousState, currentState)
{
//    log(JSON.stringify(currentState, null, 4));
    let actions = [];
    let difference = diff(previousState, currentState);
    
    for(let _d in difference) 
    {
        let df = difference[_d];
    //    log (JSON.stringify(df, null, 4));
        switch (df.kind) 
        {
            // add new
            case 'N':
            {
                // new table created
                if (df.path.length === 1)
                {
                    let depends = [];
                    let tableName = df.rhs.tableName;
                    _.each(df.rhs.schema, (v) => { if ( v.references ) depends.push(v.references.model)});

                    let options = {};
                    if (typeof df.rhs.charset !== 'undefined') 
                    {
                        options.charset = df.rhs.charset;
                    }

                    actions.push({
                        actionType: 'createTable',
                        tableName: tableName,
                        attributes: df.rhs.schema,
                        options: options,
                        depends: depends
                    });
                    
                    if(df.rhs.audit === true) {
                        actions.push({
                            actionType: 'addAudit',
                            tableName: tableName,
                            depends: [tableName]
                        });
                    }
                    
                    // create indexes
                    if (df.rhs.indexes)
                        for(let _i in df.rhs.indexes)
                        {
                            actions.push(_.extend({
                                actionType: 'removeIndex',
                                tableName: tableName,
                                depends: [ tableName ]
                            }, _.clone(df.rhs.indexes[_i])));
                            
                            actions.push(_.extend({
                                actionType: 'addIndex', 
                                tableName: tableName,
                                depends: [ tableName ]
                            }, _.clone(df.rhs.indexes[_i])));
                        }
                    break;
                }
                
                let tableName = df.path[0];
                let depends = [tableName];
                        
                if (df.path[1] === 'schema')
                {
                    // if (df.path.length === 3) - new field
                    if (df.path.length === 3)
                    {
                        // new field
                        if (df.rhs && df.rhs.references)
                            depends.push(df.rhs.references.model);
                        
                        actions.push({
                            actionType: 'addColumn',
                            tableName: tableName,
                            attributeName: df.path[2],
                            options: df.rhs,
                            depends: depends
                        });
                        break;
                    }
                    
                    // if (df.path.length > 3) - add new attribute to column (change col)            
                    if (df.path.length > 3)
                    {
                        if (df.path[1] === 'schema')
                        {                
                            // new field attributes
                            let options = currentState[tableName].schema[df.path[2]];
                            if (options.references)
                                depends.push(options.references.nodel);
                            
                            actions.push({
                                actionType: 'changeColumn',
                                tableName: tableName,
                                attributeName: df.path[2],
                                options: options,
                                depends: depends
                            });
                            break;
                        }
                    }                
                }
    
                // new index
                if (df.path[1] === 'indexes')
                {
                    let tableName = df.path[0];
                    let index = _.clone(df.rhs);
                    if(index) {
                        index.actionType = 'addIndex';
                        index.tableName = tableName;
                        index.depends = [ tableName ];
                        actions.push(index);
                    }
                    break;
                }
            }
            break;
            
            // drop
            case 'D':
            {
                let tableName = df.path[0];
                let depends = [tableName];
                
                if (df.path.length === 1)
                {
                    // drop table
                    actions.push({
                        actionType: 'dropTable',
                        tableName: tableName,
                        depends: []
                    });
                    break;
                }
                
                if (df.path[1] === 'schema')
                {
                    // if (df.path.length === 3) - drop field
                    if (df.path.length === 3)
                    {
                        // drop column
                        actions.push({
                            actionType: 'removeColumn',
                            tableName: tableName,
                            columnName: df.path[2],
                            depends: [ tableName ],
                            options: df.lhs
                        });
                        break;
                    }
                    
                    // if (df.path.length > 3) - drop attribute from column (change col)            
                    if (df.path.length > 3)
                    {
                        // new field attributes
                        let options = currentState[tableName].schema[df.path[2]];
                        if (options.references)
                            depends.push(options.references.nodel);
                        
                        actions.push({
                            actionType: 'changeColumn',
                            tableName: tableName,
                            attributeName: df.path[2],
                            options: options,
                            depends: depends
                        });
                        break;
                    }                  
                }
                
                if (df.path[1] === 'indexes')
                {
//                    log(df)
                     actions.push({
                         actionType: 'removeIndex',
                         tableName: tableName,
                         fields: df.lhs.fields,
                         options: df.lhs.options,
                         depends: [ tableName ]
                     });
                     break;
                }
            }
            break;
                
            // edit
            case 'E':
            {
                let tableName = df.path[0];
                let depends = [tableName];
                
                if (df.path[1] === 'schema')
                {
                    // new field attributes
                    let options = currentState[tableName].schema[df.path[2]];
                    if (options.references)
                        depends.push(options.references.nodel);
                    
                    actions.push({
                        actionType: 'changeColumn',
                        tableName: tableName,
                        attributeName: df.path[2],
                        options: options,
                        depends: depends
                    });
                }
                
                // updated index
                // only support updating and dropping indexes
                if (df.path[1] === 'indexes')
                {
                    let tableName = df.path[0];
                    let keys = Object.keys(df.rhs)

                    for (let k in keys) {
                        let key = keys[k]
                        let index = _.clone(df.rhs[key]);
                        actions.push({
                            actionType: 'addIndex',
                            tableName: tableName,
                            fields: df.rhs[key].fields,
                            options: df.rhs[key].options,
                            depends: [ tableName ]
                        });
                        break;
                    }

                    keys = Object.keys(df.lhs)
                    for (let k in keys) {
                        let key = keys[k]
                        let index = _.clone(df.lhs[key]);
                        actions.push({
                            actionType: 'removeIndex',
                            tableName: tableName,
                            fields: df.lhs[key].fields,
                            options: df.lhs[key].options,
                            depends: [ tableName ]
                        });
                        break;
                    }
                }

            }
            break;
    
            // array change indexes
            case 'A':
            {
                log("[Not supported] Array model changes! Problems are possible. Please, check result more carefully!");
                log("[Not supported] Difference: ");
                log(JSON.stringify(df, null, 4));
            }
            break;
            
            default:
                // code
                break;
        }
    }
    return actions;
};

const sortActions = function(actions)
{
    const orderedActionTypes = [
        'removeIndex',
        'removeColumn',       
        'dropTable',
        'createTable',
        'addColumn',
        'changeColumn',
        'addIndex',
        'addAudit'
    ];

    actions.sort((a, b) => orderedActionTypes.indexOf(a.actionType) - orderedActionTypes.indexOf(b.actionType));
    
    // sort dependencies
    for (let i = 0; i < actions.length ; i++)
    {
        let j = i + 1;
        if (!actions[i].depends || actions[i].depends.length === 0) 
            continue;

        while(j < actions.length) {
            if (actions[i].actionType !== actions[j].actionType) 
                break;

            if(actions[i].depends.indexOf(actions[j].tableName) !== -1) {
                let [c] = actions.splice(j, 1);
                actions.splice(i, 0, c);
                j = i + 2;
            } else {
                j += 1;
            }
        }
    }
        
    // remove duplicate changeColumns
    for (let i = 0; i < actions.length ; i++)
    {
        if (_.isEqual(actions[i], actions[i-1])) {
            actions.splice(i, 1);
        }
    }
};


const getPartialMigration = function(actions) 
{
    let propertyToStr = (obj) => {
        let vals = [];
        for (let k in obj)
        {
            if (k === 'seqType')
            {
                vals.push('"type": '+obj[k]);
                continue;
            }
            
            if (k === 'defaultValue')
            {
                if (obj[k].internal)
                {
                    vals.push('"defaultValue": '+obj[k].value);
                    continue;
                }
                if (obj[k].notSupported)
                    continue;

                let x = {};
                x[k] = obj[k].value;
                vals.push(JSON.stringify(x).slice(1, -1));
                continue;
            }
            
            let x = {};
            x[k] = obj[k];
            vals.push(JSON.stringify(x).slice(1, -1));
        }
        
        return '{ ' + vals.reverse().join(', ') + ' }';
    };
    
    let getAttributes = (attrs) => {
        let ret = [];
        for (let attrName in attrs)
        {
            ret.push(`      "${attrName}": ${propertyToStr(attrs[attrName])}`);
        }
        return " { \n" + ret.join(", \n") + "\n     }";
    };

    let addTransactionToOptions = (options) => {
      let ret = JSON.stringify({...options, transaction: '###TRANSACTION###'});
      ret = ret.replace('"###TRANSACTION###"', 'transaction');
      return ret;
    };

    let commands = [];
    let consoleOut = [];

    for (let _i in actions)
    {
        let action = actions[_i];
        switch (action.actionType)
        {
            case 'createTable':
            {
let resUp =`{ fn: "createTable", params: [
    "${action.tableName}",
    ${getAttributes(action.attributes)},
    ${addTransactionToOptions(action.options)}
] }`;
                commands.push(resUp);

                consoleOut.push(`createTable "${action.tableName}", deps: [${action.depends.join(', ')}]`);
            }
            break;

            case 'dropTable':
            {
                let res = `{ fn: "dropTable", params: ["${action.tableName}", {transaction: transaction}] }`;
                commands.push(res);

                consoleOut.push(`dropTable "${action.tableName}"`);
            }
            break;

            case 'addColumn':
            {
let resUp = `{ fn: "addColumn", params: [
    "${action.tableName}",
    "${(action.options && action.options.field) ? action.options.field : action.attributeName}",
    ${propertyToStr(action.options)},
    {transaction: transaction}
] }`;

                commands.push(resUp);

                consoleOut.push(`addColumn "${action.attributeName}" to table "${action.tableName}"`);
            }
            break;
            
            case 'addAudit':
            {
let resUp = `{ fn: "query", params: [
    "SELECT audit_table('${action.tableName}');",
    {transaction: transaction}
] }`;

                commands.push(resUp);
                consoleOut.push(`addAudit to table "${action.tableName}"`);
            }
            break;

            case 'removeColumn':
            {
let res = `{ fn: "removeColumn", params: [
    "${action.tableName}",
    "${(action.options && action.options.field) ? action.options.field : action.columnName}",
    {transaction: transaction}
  ]
}`;
                commands.push(res);

                consoleOut.push(`removeColumn "${(action.options && action.options.field) ? action.options.field : action.columnName}" from table "${action.tableName}"`);
            }
            break;

            case 'changeColumn':
            {
let res = `{ fn: "changeColumn", params: [
    "${action.tableName}",
    "${(action.options && action.options.field) ? action.options.field : action.attributeName}",
    ${propertyToStr(action.options)},
    {transaction: transaction}
] }`;
                commands.push(res);

                consoleOut.push(`changeColumn "${action.attributeName}" on table "${action.tableName}"`);
            }
            break;

            case 'addIndex':
            {
let res = `{ fn: "addIndex", params: [
    "${action.tableName}",
    ${JSON.stringify(action.fields)},
    ${addTransactionToOptions(action.options)}
] }`;
                commands.push(res);

                let nameOrAttrs = (action.options && action.options.indexName && action.options.indexName != '') ? `"${action.options.indexName}"` : JSON.stringify(action.fields);
                consoleOut.push(`addIndex ${nameOrAttrs} to table "${action.tableName}"`);
            }
            break;

            case 'removeIndex':
            {
//                log(action)
                let nameOrAttrs = (action.options && action.options.indexName && action.options.indexName != '') ? `"${action.options.indexName}"` : JSON.stringify(action.fields);

let res = `{ fn: "removeIndex", params: [
    "${action.tableName}",
    ${nameOrAttrs},
    {transaction: transaction}
] }`;
                commands.push(res);

                consoleOut.push(`removeIndex ${nameOrAttrs} from table "${action.tableName}"`);
            }
            break;
            
            default:
                // code
        }
    }

    return { commands, consoleOut };
};

const getMigration = function(upActions, downActions) 
{
    let { commands: commandsUp, consoleOut } = getPartialMigration(upActions);
    let { commands: commandsDown } = getPartialMigration(downActions);
    return { commandsUp, commandsDown, consoleOut };
};


const writeMigration = function(revision, migration, migrationsDir, name = '', comment = '')
{
    let _commandsUp = "let migrationCommands = function(transaction) {return [ \n" + migration.commandsUp.join(", \n") +' \n];};\n';
    let _commandsDown = "let rollbackCommands = function(transaction) {return [ \n" + migration.commandsDown.join(", \n") +' \n];};\n';
    let _actions = ' * ' + migration.consoleOut.join("\n * ");

    // _commandsUp = beautify(_commandsUp);
    // _commandsDown = beautify(_commandsDown);
    let info = {
        revision,
        name,
        created: new Date(),
        comment
    };
    
    let template = `/* eslint-disable prefer-spread */
/* eslint-disable prefer-template */
'use strict';
const Sequelize = require('sequelize');

/**
 * Actions summary:
 *
${_actions}
 *
 **/

let info = ${JSON.stringify(info, null, 2)};

${_commandsUp}
${_commandsDown}

module.exports = {
    pos: 0,
    useTransaction: true,
    execute: function(queryInterface, Sequelize, _commands) {
        let index = this.pos;
        function run(transaction) {
            const commands = _commands(transaction);
            return new Promise(function(resolve, reject) {
                function next() {
                    if(index < commands.length) {
                        let command = commands[index];
                        const tableName = (command.params && command.params[0]) || '<no table name>';
                        console.log("[#"+index+"] execute: " + command.fn + " " + tableName);
                        index += 1;
                        if(command.fn === 'query') 
                            queryInterface.sequelize.query.apply(queryInterface.sequelize, command.params).then(next, reject);
                        else
                            queryInterface[command.fn].apply(queryInterface, command.params).then(next, reject);
                    } else resolve();
                }
                next();
            });
        }
        if(this.useTransaction) return queryInterface.sequelize.transaction(run);
        return run(null);
    },
    up: function(queryInterface, Sequelize) {
        return this.execute(queryInterface, Sequelize, migrationCommands);
    },
    down: function(queryInterface, Sequelize) {
        return this.execute(queryInterface, Sequelize, rollbackCommands);
    },
    info: info
};
`;

    name = name.replace(' ', '_');
    let filename = path.join(migrationsDir, getCurrentYYYYMMDDHHmms() + '-' + revision + ((name != '') ? `-${name}` : '') + '.js');
    fs.writeFileSync(filename, beautify(template, { indent_size: 2, end_with_newline: true }));
    
    return {filename, info};
};

const format = function (i) {
    return parseInt(i, 10) < 10 ? '0' + i : i;
}; 

const getCurrentYYYYMMDDHHmms = function () {
    const date = new Date();
    return [
        date.getUTCFullYear(),
        format(date.getUTCMonth() + 1),
        format(date.getUTCDate()),
        format(date.getUTCHours()),
        format(date.getUTCMinutes()),
        format(date.getUTCSeconds())
    ].join('');
};

const executeMigration = function(queryInterface, filename, useTransaction, pos, rollback, cb)
{
    let mig = require(filename);
    
    if (!mig)
        return cb("Can't require file "+filename);
    
    if (pos > 0)
    {
        console.log("Set position to "+pos);
        mig.pos = pos;
    }
    mig.useTransaction = useTransaction;
    
    if (rollback) {
        if (typeof mig.down !== 'function') {
            return cb("No rollback command");
        }
        mig.down(queryInterface, Sequelize).then(
            () => {
                cb();
            }, 
            (err) => {
                cb(err);
            }
        );
    } else {
        mig.up(queryInterface, Sequelize).then(
            () => {
                cb();
            }, 
            (err) => {
                cb(err);
            }
        );
    }
};

module.exports = { writeMigration, getMigration, sortActions, parseDifference, reverseModels, executeMigration };
