connection: "ecommerce"

view: order_items {
  sql_table_name: analytics.order_items ;;
  dimension: id { primary_key: yes  type: number  sql: ${TABLE}.id ;; }
  dimension: order_id { type: number  sql: ${TABLE}.order_id ;; }
  dimension: user_id { type: number  sql: ${TABLE}.user_id ;; }
}

view: orders {
  sql_table_name: analytics.orders ;;
  dimension: id { primary_key: yes  type: number  sql: ${TABLE}.id ;; }
}

view: users {
  sql_table_name: analytics.users ;;
  dimension: id { primary_key: yes  type: number  sql: ${TABLE}.id ;; }
}

explore: order_items {
  label: "Order Items"
  join: orders {
    type: left_outer
    relationship: many_to_one
    sql_on: ${order_items.order_id} = ${orders.id} ;;
  }
  join: users {
    type: left_outer
    relationship: many_to_one
    foreign_key: user_id
  }
}
