global.DbScreen = jClass.extend({
  type: "db_screen",

  options: {
    fetchDbList: true
  },

  init: function(connection, options) {
    node.util._extend(this.options, options);

    this.connection = connection;
    this.view = new DbScreenView(this);

    this.currentTab = null;

    if (this.options.fetchDbList) this.fetchDbList();

    this.database = this.connection.options.database;
    App.emit('database.changed', this.database);
    this.fetchTablesAndSchemas(() => {
      this.view.showDatabaseContent();
    });

    this.connection.onNotification((message) => {
      window.alertify.alert("Recieve Message:<br>" + JSON.stringify(message));
    });
  },

  // short cut
  query: function(sql, callback){
    return this.connection.query(sql, callback);
  },

  omit: function (event) {
    if (this.view.currentTab == 'users' && (event == 'user.created' || event == 'user.deleted' || event == 'user.updated')) {
      this.usersTabActivate();
    }

    if (this.view.currentTab == 'extensions' && (event == 'extension.installed' || event == 'extension.uninstalled')) {
      this.extensionsTabActivate();
    }

    if (event == 'table.created') {
      //
    }
  },

  listen: function (event, callback) {
    
  },

  fetchDbList: function (callback) {
    return this.connection.server.listDatabases().then(databases => {
      this.view.renderDbList(databases);
      callback && callback();
    });
  },

  listDatabases: function(callback){
    this.connection.server.listDatabases(callback);
  },

  selectDatabase: function (database, callback) {
    if (database == '') database = undefined;

    this.database = database;
    App.emit('database.changed', this.database);

    this.currentTable = null;
    this.currentSchema = null;

    if (database) {
      this.connection.switchDb(this.database, () => {
        this.fetchTablesAndSchemas();
        if (typeof callback == 'function') callback();
        if (['extensions', 'procedures'].includes(this.view.currentTab)) {
          this.view.showTab(this.view.currentTab);
        }
      });
    } else {
      this.view.hideDatabaseContent();
      this.connection.close();
    }
  },

  // Public API
  setDatabase: function (database, callback) {
    this.view.setDabase(database, callback);
  },

  fetchTablesAndSchemas: function (callback) {
    App.startLoading("Getting tables list...");
    return this.connection.tablesAndSchemas((data) => {
      return this.connection.mapViewsAsTables((matViews) => {
        // join tables with views
        Object.forEach(matViews, (schema, views) => {
          if (!data[schema]) data[schema] = [];
          views.forEach((view) => {
            data[schema].push(view);
          });
        });
        // sort everything again
        Object.forEach(data, (schema, tables) => {
          data[schema] = tables.sort((a, b) => {
            if (a.table_name > b.table_name) return 1;
            if (a.table_name < b.table_name) return -1;
            return 0;
          })
        });
        App.stopLoading();
        this.view.renderTablesAndSchemas(data, this.currentSchema, this.currentTable);
        callback && callback(data);
      });
    });
  },

  tableSelected: function(schema, tableName, node, showTab) {
    if (this.currentSchema == schema && this.currentTable == tableName) {
      return;
    }
    this.currentSchema = schema;
    this.currentTable = tableName;

    App.emit('table.changed', this.currentSchema, this.currentTable);

    this.table = Model.Table(this.currentSchema, this.currentTable);

    if (this.currentTableNode) this.currentTableNode.removeClass('selected');
    this.currentTableNode = $u(node);
    this.currentTableNode.addClass('selected');

    if (showTab) {
      this.view.showTab(showTab);
    } else if (['structure', 'content', 'info'].includes(this.view.currentTab)) {
      this.view.showTab(this.view.currentTab);
    } else {
      this.view.showTab('structure');
    }
  },

  activateTab: function (tabName, force) {
    console.log(tabName + 'TabActivate', typeof this[tabName + 'TabActivate']);

    if (this.currentTab == tabName && !force) {
      return;
    }

    if (this[tabName + 'TabActivate']) {
      this.currentTab = tabName;
      App.emit('dbtab.changed', this.currentTab);
      this[tabName + 'TabActivate']();
    }
  },

  extensionsTabActivate: function () {
    this.connection.getExtensions((rows) => {
      this.view.extensionsPane.renderTab(rows);
      this.currentTab = 'extensions';
    });
  },

  installExtension: function (extension, callback) {
    App.startLoading(`Installing extension ${extension}`);
    this.connection.installExtension(extension, (data, error) => {
      App.stopLoading();
      if (!error) this.omit('extension.installed');
      callback(data, error);
    });
  },

  uninstallExtension: function (extension, callback) {
    App.startLoading(`Removing extension ${extension}`);
    this.connection.uninstallExtension(extension, (data, error) => {
      App.stopLoading();
      if (!error) this.omit('extension.uninstalled');
      callback(data, error);
    });
  },

  contentTabLimit: 200,

  contentTabActivate: function() {
    if (!this.currentTable) {
      this.view.setTabMessage("Please select table or view");
      return;
    }

    App.startLoading("Fetching data ...", {
      cancel: function () {
        App.stopRunningQuery();
      }
    });
    this.table.getColumnTypes((columnTypes, error2) => {
      var hasOid = !!columnTypes.oid;
      var extraColumns = [];
      Object.forEach(columnTypes, (key, col) => {
        if (/geometry\(Point\)/.test(col.data_type)) {
          extraColumns.push(`ST_AsText(${key}) as ${key}`);
        }
      });
      this.table.getRows(0, this.contentTabLimit, {with_oid: hasOid, extraColumns: extraColumns}, (data, error) => {
        App.stopLoading();
        this.view.contentPane.renderTab(data, columnTypes, error || error2);
        this.currentTab = 'content';
      });
    });
  },

  queryTabActivate: function () {
    this.view.queryPane.renderTab();
    this.currentTab = 'query';
  },

  usersTabActivate: async function () {
    var users = await Model.User.findAll();
    this.view.usersPane.renderTab(users);
    this.currentTab = 'users';
  },

  createUser: async function(data, callback) {
    if (data.admin == '1') {
      delete data.admin;
      data.superuser = true;
    }

    var result = await Model.User.create(data);
    this.omit('user.created');
    return result;
  },

  updateUser: async function(username, data) {
    if (data.admin == '1') {
      delete data.admin;
      data.superuser = true;
    }

    var result = await new Model.User(username).update(data);
    this.omit('user.updated');
    return result;
  },

  deleteUser: async function(username) {
    var result = await Model.User.drop(username);
    this.omit('user.deleted');
    return result;
  },

  createDatabase: async function (data, callback) {
    await this.connection.switchDb(this.connection.defaultDatabaseName);
    var res = await this.connection.server.createDatabase(data.dbname, data.template, data.encoding);
    await this.fetchDbList();
    this.view.databaseSelect.val(data.dbname).change();

    return res;
  },

  dropDatabaseDialog: async function () {
    var msg = `Delete database ${this.database}?`;
    var result = await $u.confirm(msg, {
      detail: "It will delete all tables in it",
      button: "Drop Database",
      defaultId: 1
    });

    if (result) {
      this.dropDatabase();
    }
  },

  dropDatabase: async function () {
    App.startLoading("Deleting database...");
    try {
      await this.connection.server.dropDatabase(this.database);
      this.database = undefined;
      this.view.hideDatabaseContent();
      this.fetchDbList();
      App.emit('database.changed', this.database);
    } catch (error) {
      window.alertify.alert(error.message);
    }
    App.stopLoading();
  },

  renameDatabaseDialog: function (defaultValue) {
    var msg = "Renaming database '" + this.database + "'?";
    window.alertify.prompt(msg, (result, newName) => {
      if (result) {
        if (newName && newName.trim() != "" && newName != this.database) {
          this.renameDatabase(newName);
        } else {
          window.alert('Please fill database name');
          this.renameDatabaseDialog(newName);
          setTimeout(() => {
            $u('#alertify-text').focus();
          }, 200);
        }
      }
    }, defaultValue || this.database);
  },

  renameDatabase: async function (databaseNewName) {
    App.startLoading("Renaming database...");
    try {
      await this.connection.server.renameDatabase(this.database, databaseNewName);
      this.database = databaseNewName;
      this.fetchDbList();
      App.emit('database.changed', this.database);
    } catch (error) {
      window.alertify.alert(error.message);
    }
    App.stopLoading();
  },

  createTable: function (data, callback) {
    App.startLoading(`Creating table table ${data.name}`);
    Model.Table.create(data.tablespace, data.name, (table, res, error) => {
      App.stopLoading();
      if (!error) {
        this.omit('table.created');
        this.fetchTablesAndSchemas((tables) => {
          var tableElement = this.view.sidebar.find('[schema-name=' + data.tablespace + '] ' +
                                                      '[table-name=' + data.name + ']')[0];
          this.tableSelected(data.tablespace, data.name, tableElement, 'structure');
        });
      }
      callback(res, error);
    });
  },

  _relationTitle: function (type) {
    return {
      "VIEW": 'view',
      "BASE TABLE": 'table',
      "MATERIALIZED VIEW": 'materialized view',
      'FOREIGN TABLE': 'foreign table'
    }[type] || type;
  },

  dropRelation: async function (schema, tableName, callback) {
    var table = new Model.Table(schema, tableName);

    var type = await table.getTableType();
    var tableTitle = this._relationTitle(type);

    var message = `Delete ${tableTitle} ${schema}.${tableName}?`;
    if (await $u.confirm(message)) {
      await table.remove();
      this.omit('table.deleted');
      this.fetchTablesAndSchemas();
    }
  },

  refreshMatView: async function (schema, tableName) {
    var table = new Model.Table(schema, tableName);

    App.startLoading(`Refreshing ${schema}.${tableName}...`);
    var res = await table.refreshMatView();
    App.stopLoading();

    return res;
  },

  renameTable: async function (schema, tableName, newName) {
    if (tableName == newName) {
      console.log("Try rename table '" + tableName + "' -> '" + newName + "', canceled, same value");
      return;
    }

    var table = new Model.Table(schema, tableName);

    var type = await table.getTableType();
    var tableTitle = this._relationTitle(type);

    App.startLoading(`Renaming ${tableTitle} ${tableName} to ${newName}`);

    var result = await table.rename(newName);

    App.stopLoading();

    if (this.currentTable == tableName) {
      this.currentTable = newName;
    }
    this.omit('table.renamed');
    this.fetchTablesAndSchemas();

    return result;
  },

  structureTabActivate: async function () {
    if (!this.currentTable) {
      this.view.setTabMessage("Please select table or view");
      return;
    }
    App.startLoading("Getting table structure...");

    try {
      var isMatView = await this.table.isMatView();
    } catch (error) {
      errorReporter(error, false);
    }

    try {
      var rows = await this.table.getStructure();
    } catch (error) {
      var columnsError = error;
      errorReporter(error, false);
    }

    try {
      var indexes = await Model.Index.list(this.table);
    } catch (error) {
      var indexesError = error;
      errorReporter(error, false);
    }

    try {
      var constraints = await this.table.getConstraints();
    } catch (error) {
      var constraintsError = error;
      errorReporter(error, false);
    }

    this.view.structurePane.renderTab(rows, indexes, constraints, {
      isMatView: isMatView,
      columnsError: columnsError,
      indexesError: indexesError,
      constraintsError: constraintsError
    });
    App.stopLoading();
  },

  proceduresTabActivate: function() {
    this.view.proceduresPane.renderTab(() => {
      this.currentTab = 'procedures';
    });
  },

  addColumn: async function (data, callback) {
    App.startLoading(`Adding column ${data.name}`);
    var column = new Model.Column({
      table: this.table,
      name: data.name,
      type: data.type,
      max_length: data.max_length,
      default_value: data.default_value,
      allow_null: data.allow_null
    });

    console.log(column);

    try {
      await column.create();
      this.structureTabActivate();
    } finally {
      App.stopLoading();
    }
  },

  updateColumn: async function (columnObj, data, callback) {
    App.startLoading(`Updating column ${columnObj.data.column_name}`);

    try {
      await columnObj.update(data);
      this.structureTabActivate();
    } finally {
      App.stopLoading();
    }
  },

  deleteColumn: async function (columnName) {
    App.startLoading(`Deleting column ${columnName}`);
    var column = new Model.Column(columnName, {table: this.table});
    try {
      await column.drop();
      this.structureTabActivate();
    } finally {
      App.stopLoading();
    }
  },

  addIndex: async function (data, callback) {
    App.startLoading(`Adding index ${data.name}`);

    try {
      var result = await Model.Index.create(this.table, data.name, {
        uniq: data.uniq,
        columns: data.columns,
        method: data.method
      })
      this.structureTabActivate()
      return result;
    } finally {
      App.stopLoading();
    }
  },

  deleteIndex: async function (indexName, callback) {
    App.startLoading(`Deleting index ${indexName}`);

    try {
      var index = new Model.Index(indexName, this.table);
      await index.drop()
      this.structureTabActivate()
    } finally {
      App.stopLoading();
    }
  },

  deleteConstraint: function (constraintName, callback) {
    App.startLoading(`Deleting constraint ${constraintName}`);
    this.table.dropConstraint(constraintName, (result, error) => {
      App.stopLoading();
      if (!error) this.structureTabActivate();
      callback(result, error);
    });
  },

  getTableSql: function (schema, table, callback) {
    Model.Table(schema, table).getSourceSql((source) => {
      callback(source);
    });
  },

  infoTabActivate: function () {
    if (!this.currentTable) {
      this.view.setTabMessage("Please select table or view");
      return;
    }

    var table = this.tableObj();

    this.view.setTabMessage("Getting table information ...");

    App.startLoading("Getting table info...");
    table.getSourceSql((code, dumpError) => {
      table.diskSummary((relType, estimateCount, diskUsage, error) => {
        if (dumpError) {
          //window.alert("Running pg_dump failed:\n" + dumpError);
          //global.errorReporter(dumpError, false);
        }
        if (error) {
          global.errorReporter(error, false);
        }
        App.stopLoading();
        this.view.infoPane.renderTab({source: code, error: dumpError}, relType, estimateCount, diskUsage);
        this.currentTab = 'info';
      });
    });
  },

  // TODO: add caching
  tableObj: function() {
    return Model.Table(this.currentSchema, this.currentTable);
  },

  switchToHerokuMode: function (appName, dbUrl) {
    this.view.switchToHerokuMode(appName, dbUrl);
  },

  destroy: function () {
    this.connection.close();
  },

  reconnect: function (callback) {
    this.connection.reconnect((success, error) => {
      if (success) {
        window.alertify.alert('Reconnected!');
        if (callback) callback(true);
      } else {
        window.alertify.alert('Connection error.<br>' + (error.message || error));
        if (callback) callback(false);
      }
    });
  },

  truncateTable(schema, table, cascade, callback) {
    App.startLoading(`Truncating ${table}`);
    Model.Table(schema, table).truncate(cascade, (result, error) => {
      App.stopLoading();
      callback(result, error);
    });
  }
});

