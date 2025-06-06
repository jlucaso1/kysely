import {
  DatabaseIntrospector,
  DatabaseMetadata,
  DatabaseMetadataOptions,
  SchemaMetadata,
  TableMetadata,
} from '../database-introspector.js'
import {
  DEFAULT_MIGRATION_LOCK_TABLE,
  DEFAULT_MIGRATION_TABLE,
} from '../../migration/migrator.js'
import { Kysely } from '../../kysely.js'
import { freeze } from '../../util/object-utils.js'
import { sql } from '../../raw-builder/sql.js'

export class PostgresIntrospector implements DatabaseIntrospector {
  readonly #db: Kysely<any>

  constructor(db: Kysely<any>) {
    this.#db = db
  }

  async getSchemas(): Promise<SchemaMetadata[]> {
    let rawSchemas = await this.#db
      .selectFrom('pg_catalog.pg_namespace')
      .select('nspname')
      .$castTo<RawSchemaMetadata>()
      .execute()

    return rawSchemas.map((it) => ({ name: it.nspname }))
  }

  async getTables(
    options: DatabaseMetadataOptions = { withInternalKyselyTables: false },
  ): Promise<TableMetadata[]> {
    let query = this.#db
      // column
      .selectFrom('pg_catalog.pg_attribute as a')
      // table
      .innerJoin('pg_catalog.pg_class as c', 'a.attrelid', 'c.oid')
      // table schema
      .innerJoin('pg_catalog.pg_namespace as ns', 'c.relnamespace', 'ns.oid')
      // column data type
      .innerJoin('pg_catalog.pg_type as typ', 'a.atttypid', 'typ.oid')
      // column data type schema
      .innerJoin(
        'pg_catalog.pg_namespace as dtns',
        'typ.typnamespace',
        'dtns.oid',
      )
      .select([
        'a.attname as column',
        'a.attnotnull as not_null',
        'a.atthasdef as has_default',
        'c.relname as table',
        'c.relkind as table_type',
        'ns.nspname as schema',
        'typ.typname as type',
        'dtns.nspname as type_schema',
        sql<string | null>`col_description(a.attrelid, a.attnum)`.as(
          'column_description',
        ),
        sql<
          string | null
        >`pg_get_serial_sequence(quote_ident(ns.nspname) || '.' || quote_ident(c.relname), a.attname)`.as(
          'auto_incrementing',
        ),
      ])
      .where('c.relkind', 'in', [
        'r' /*regular table*/,
        'v' /*view*/,
        'p' /*partitioned table*/,
      ])
      .where('ns.nspname', '!~', '^pg_')
      .where('ns.nspname', '!=', 'information_schema')
      // Filter out internal cockroachdb schema
      .where('ns.nspname', '!=', 'crdb_internal')
      // No system columns
      .where('a.attnum', '>=', 0)
      .where('a.attisdropped', '!=', true)
      .orderBy('ns.nspname')
      .orderBy('c.relname')
      .orderBy('a.attnum')
      .$castTo<RawColumnMetadata>()

    if (!options.withInternalKyselyTables) {
      query = query
        .where('c.relname', '!=', DEFAULT_MIGRATION_TABLE)
        .where('c.relname', '!=', DEFAULT_MIGRATION_LOCK_TABLE)
    }

    const rawColumns = await query.execute()

    return this.#parseTableMetadata(rawColumns)
  }

  async getMetadata(
    options?: DatabaseMetadataOptions,
  ): Promise<DatabaseMetadata> {
    return {
      tables: await this.getTables(options),
    }
  }

  #parseTableMetadata(columns: RawColumnMetadata[]): TableMetadata[] {
    return columns.reduce<TableMetadata[]>((tables, it) => {
      let table = tables.find(
        (tbl) => tbl.name === it.table && tbl.schema === it.schema,
      )

      if (!table) {
        table = freeze({
          name: it.table,
          isView: it.table_type === 'v',
          schema: it.schema,
          columns: [],
        })

        tables.push(table)
      }

      table.columns.push(
        freeze({
          name: it.column,
          dataType: it.type,
          dataTypeSchema: it.type_schema,
          isNullable: !it.not_null,
          isAutoIncrementing: it.auto_incrementing !== null,
          hasDefaultValue: it.has_default,
          comment: it.column_description ?? undefined,
        }),
      )

      return tables
    }, [])
  }
}

interface RawSchemaMetadata {
  nspname: string
}

interface RawColumnMetadata {
  column: string
  table: string
  table_type: string
  schema: string
  not_null: boolean
  has_default: boolean
  type: string
  type_schema: string
  auto_incrementing: string | null
  column_description: string | null
}
