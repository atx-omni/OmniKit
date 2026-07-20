view: orders {
  sql_table_name: analytics.orders ;;

  dimension: id {
    primary_key: yes
    type: number
    sql: ${TABLE}.id ;;
  }

  dimension_group: created {
    type: time
    timeframes: [date, month, year]
    sql: ${TABLE}.created_at ;;
  }

  dimension: amount {
    type: number
    value_format_name: usd
    sql: ${TABLE}.amount ;;
  }

  measure: total_amount {
    type: sum
    sql: ${amount} ;;
    value_format_name: usd
  }

  measure: order_count {
    type: count
  }
}
