view: example_orders {
  sql_table_name: analytics.orders ;;

  parameter: segment_mode {
    type: unquoted
    allowed_value: { label: "Enterprise" value: "enterprise" }
    allowed_value: { label: "Commercial" value: "commercial" }
  }

  dimension: id {
    primary_key: yes
    type: number
    sql: ${TABLE}.id ;;
  }

  dimension_group: created {
    type: time
    timeframes: [date, week, month]
    sql: ${TABLE}.created_at ;;
  }

  dimension: status {
    type: string
    sql: ${TABLE}.status ;;
  }

  measure: order_count {
    type: count
  }

  measure: completed_order_count {
    type: count
    filters: [status: "completed"]
  }

  measure: enterprise_order_count {
    type: count
    filters: [example_accounts.segment: "enterprise"]
  }
}

view: example_accounts {
  sql_table_name: analytics.accounts ;;

  dimension: id {
    primary_key: yes
    type: number
    sql: ${TABLE}.id ;;
  }

  dimension: segment {
    type: string
    sql: ${TABLE}.segment ;;
  }
}

view: example_order_rollup {
  derived_table: {
    explore_source: example_orders {
      column: status { field: example_orders.status }
    }
  }
}
