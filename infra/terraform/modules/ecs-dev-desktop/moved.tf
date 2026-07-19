moved {
  from = aws_vpc.this
  to   = aws_vpc.this[0]
}

moved {
  from = aws_internet_gateway.this
  to   = aws_internet_gateway.this[0]
}

moved {
  from = aws_route_table.public
  to   = aws_route_table.public[0]
}

moved {
  from = aws_vpc_endpoint.s3
  to   = aws_vpc_endpoint.s3[0]
}

moved {
  from = aws_vpc_endpoint.dynamodb
  to   = aws_vpc_endpoint.dynamodb[0]
}

moved {
  from = aws_ecs_cluster.this
  to   = aws_ecs_cluster.this[0]
}

moved {
  from = aws_ecs_cluster_capacity_providers.this
  to   = aws_ecs_cluster_capacity_providers.this[0]
}
